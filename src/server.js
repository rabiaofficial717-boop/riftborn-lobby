'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Store, publicProfile } = require('./store');
const { Lobby } = require('./lobby');

const PROTOCOL_VERSION = 2;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the Unity web build (including its .br / .gz files with the right headers) and the
 * game's WebSocket endpoint at /ws.
 */
function createServer(options = {}) {
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null;
  const store = new Store(options.dataFile || null, { secret: options.profileSecret });
  const lobby = new Lobby(store, { iceServers: options.iceServers });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, players: lobby.clients.size, queued: lobby.queue.length, matches: lobby.matches.size }));
      return;
    }
    if (!staticDir) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveStatic(staticDir, url.pathname, req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
  wss.on('connection', (ws) => {
    let client = null;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (client) lobby.binary(client, data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!client) {
        if (msg && msg.t === 'hello') client = hello(ws, msg);
        return;
      }
      lobby.message(client, msg);
    });
    ws.on('close', () => {
      if (client) lobby.disconnect(client);
    });
    ws.on('error', () => {});
  });

  function hello(ws, msg) {
    if (msg.version !== PROTOCOL_VERSION) {
      sendJson(ws, { t: 'error', code: 'version', message: 'Please reload: the game was updated.' });
      ws.close();
      return null;
    }
    const { profile, token } = store.login(msg.token, msg.name, msg.backup);
    const client = {
      id: profile.id,
      ws,
      sendJson: (obj) => sendJson(ws, obj),
      sendBinary: (buf) => {
        if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
      },
      close: () => ws.close(),
    };
    lobby.connect(client);
    client.sendJson({ t: 'welcome', token, profile: publicProfile(profile), backup: store.backupOf(profile), online: lobby.clients.size });
    return client;
  }

  const timers = [
    setInterval(() => lobby.tick(), 500),
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 15000),
  ];

  return {
    server,
    lobby,
    store,
    listen(port, cb) {
      server.listen(port, cb);
      return this;
    },
    close(cb) {
      timers.forEach(clearInterval);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      store.flush();
      server.close(cb);
    },
  };
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function serveStatic(root, pathname, req, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // Unity names compressed files e.g. Web.wasm.br: send them as the inner type, pre-compressed.
    let ext = path.extname(file);
    const headers = {};
    if (ext === '.br' || ext === '.gz') {
      headers['Content-Encoding'] = ext === '.br' ? 'br' : 'gzip';
      ext = path.extname(file.slice(0, -ext.length));
    }
    headers['Content-Type'] = MIME[ext] || 'application/octet-stream';
    // Build files keep their names between builds, so browsers (and Unity's own cache) must revalidate.
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers['ETag'] = etag;
    headers['Last-Modified'] = st.mtime.toUTCString();
    headers['Cache-Control'] = 'no-cache';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  // STATIC_DIR=off runs the lobby alone, for when the game files are hosted elsewhere (see Server/Dockerfile.lobby).
  const staticDir = process.env.STATIC_DIR === 'off' ? null : process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'Builds', 'Web');
  const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'players.json');
  const iceServers = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : undefined;
  // PROFILE_SECRET turns on signed profile backups (see Store); keep it the same across restarts.
  const profileSecret = process.env.PROFILE_SECRET || undefined;
  const app = createServer({ staticDir, dataFile, iceServers, profileSecret }).listen(port, () => {
    console.log(`[riftborn] http://localhost:${port}  (web build: ${staticDir}, data: ${dataFile})`);
  });
  const shutdown = () => app.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, PROTOCOL_VERSION };
