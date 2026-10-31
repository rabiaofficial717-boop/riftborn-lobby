'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer, PROTOCOL_VERSION } = require('../src/server');

function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const msg = isBinary ? { t: '#binary', data } : JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next(t) {
      const i = queue.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ t, resolve });
        setTimeout(() => reject(new Error('timeout waiting for ' + t)), 3000);
      });
    },
  };
}

test('two browsers: hello, queue, signal, go, relay, result, persisted profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(dir, 'Web.wasm.br'), Buffer.from([1, 2, 3]));
  const dataFile = path.join(dir, 'players.json');
  const app = createServer({ staticDir: dir, dataFile });
  await new Promise((r) => app.listen(0, r));
  const port = app.server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/Web.wasm.br`);
    assert.strictEqual(res.headers.get('content-type'), 'application/wasm');
    assert.strictEqual(res.headers.get('content-encoding'), 'br');

    const a = connect(port);
    const b = connect(port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Alpha' });
    b.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Bravo' });
    const wa = await a.next('welcome');
    await b.next('welcome');
    assert.strictEqual(wa.profile.name, 'Alpha');
    assert.strictEqual(wa.profile.tier, 'Unranked');

    a.send({ t: 'queue', ranked: true });
    b.send({ t: 'queue', ranked: true });
    const ma = await a.next('match');
    const mb = await b.next('match');
    assert.strictEqual(ma.seed, mb.seed);

    a.send({ t: 'signal', data: { candidate: 'c1' } });
    assert.deepStrictEqual((await b.next('signal')).data, { candidate: 'c1' });

    a.send({ t: 'ready' });
    b.send({ t: 'ready' });
    await a.next('go');
    await b.next('go');

    a.ws.send(Buffer.from([9, 8, 7]), { binary: true });
    const relayed = await b.next('#binary');
    assert.deepStrictEqual([...relayed.data], [9, 8, 7]);

    const winner = ma.side;
    a.send({ t: 'result', matchId: ma.matchId, winner, checksum: '42' });
    b.send({ t: 'result', matchId: mb.matchId, winner, checksum: '42' });
    const ra = await a.next('matchResult');
    assert.strictEqual(ra.reason, 'complete');
    assert.ok(ra.ratingAfter > ra.ratingBefore);
    assert.strictEqual(ra.profile.ranked.w, 1);

    // Reconnecting with the token returns the same profile.
    a.ws.close();
    const a2 = connect(port);
    await a2.open();
    a2.send({ t: 'hello', version: PROTOCOL_VERSION, token: wa.token });
    const back = await a2.next('welcome');
    assert.strictEqual(back.profile.id, wa.profile.id);
    assert.strictEqual(back.profile.ranked.w, 1);
    a2.ws.close();
    b.ws.close();
  } finally {
    await new Promise((r) => app.close(r));
  }
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.strictEqual(saved.players.length, 2);
  assert.ok(!JSON.stringify(saved).includes('"token"'), 'raw tokens are never stored');
});

test('old clients are told to reload', async () => {
  const app = createServer({});
  await new Promise((r) => app.listen(0, r));
  try {
    const c = connect(app.server.address().port);
    await c.open();
    c.send({ t: 'hello', version: 0 });
    assert.strictEqual((await c.next('error')).code, 'version');
  } finally {
    await new Promise((r) => app.close(r));
  }
});

test('a restarted server without a disk restores players from their backups', async () => {
  const start = async () => {
    const app = createServer({ profileSecret: 'test-secret' });
    await new Promise((r) => app.listen(0, r));
    return app;
  };
  const first = await start();
  let welcome;
  try {
    const c = connect(first.server.address().port);
    await c.open();
    c.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Alpha' });
    welcome = await c.next('welcome');
    assert.ok(welcome.backup, 'welcome carries a backup');
    c.ws.close();
  } finally {
    await new Promise((r) => first.close(r));
  }

  const second = await start();
  try {
    const c = connect(second.server.address().port);
    await c.open();
    c.send({ t: 'hello', version: PROTOCOL_VERSION, token: welcome.token, backup: welcome.backup });
    const back = await c.next('welcome');
    assert.strictEqual(back.token, welcome.token);
    assert.strictEqual(back.profile.id, welcome.profile.id);
    assert.strictEqual(back.profile.name, 'Alpha');
    c.ws.close();
  } finally {
    await new Promise((r) => second.close(r));
  }
});
