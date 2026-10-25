'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');
const { Lobby, READY_TIMEOUT_MS } = require('../src/lobby');

function setup() {
  let time = 1000;
  const store = new Store(null);
  const lobby = new Lobby(store, { now: () => time });
  const make = (name) => {
    const { profile } = store.login(null, name);
    const c = {
      id: profile.id,
      inbox: [],
      binary: [],
      sendJson(o) {
        this.inbox.push(o);
      },
      sendBinary(b) {
        this.binary.push(b);
      },
      close() {
        this.closed = true;
      },
      last(t) {
        return [...this.inbox].reverse().find((m) => m.t === t);
      },
    };
    lobby.connect(c);
    return c;
  };
  return { store, lobby, make, advance: (ms) => (time += ms) };
}

function playToGo(lobby, a, b) {
  lobby.message(a, { t: 'ready', delay: 3 });
  lobby.message(b, { t: 'ready', delay: 99 });
  assert.ok(a.last('go') && b.last('go'));
  const sa = a.last('match').side;
  const delays = a.last('go').delays;
  assert.strictEqual(delays[sa], 3);
  assert.strictEqual(delays[1 - sa], 6, 'delays are clamped');
}

test('casual queue pairs two players with opposite sides and the same seed', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: false });
  lobby.message(b, { t: 'queue', ranked: false });
  const ma = a.last('match');
  const mb = b.last('match');
  assert.ok(ma && mb);
  assert.strictEqual(ma.matchId, mb.matchId);
  assert.strictEqual(ma.seed, mb.seed);
  assert.deepStrictEqual([ma.side, mb.side].sort(), [0, 1]);
  assert.strictEqual(ma.opponent.name, 'Bravo');
});

test('ranked and casual queues never mix', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: false });
  assert.ok(!a.last('match') && !b.last('match'));
});

test('ranked pairs far-apart ratings only after waiting', () => {
  const { lobby, make, store, advance } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  store.get(a.id).glicko.rating = 2000;
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: true });
  assert.ok(!a.last('match'), 'gap 500 is too wide at first');
  advance(15000);
  lobby.tick();
  assert.ok(a.last('match'), 'allowed gap widens with time');
});

test('signals and relay packets reach only the opponent, relay only after go', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  const c = make('Charlie');
  lobby.message(a, { t: 'queue', ranked: false });
  lobby.message(b, { t: 'queue', ranked: false });
  lobby.message(a, { t: 'signal', data: { sdp: 'x' } });
  assert.deepStrictEqual(b.last('signal').data, { sdp: 'x' });
  lobby.binary(a, Buffer.from([1, 2, 3]));
  assert.strictEqual(b.binary.length, 0);
  playToGo(lobby, a, b);
  lobby.binary(a, Buffer.from([1, 2, 3]));
  assert.strictEqual(b.binary.length, 1);
  assert.strictEqual(c.binary.length, 0);
});

test('agreeing results update ranked ratings, streaks and stats', () => {
  const { lobby, make, store } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: true });
  playToGo(lobby, a, b);
  const id = a.last('match').matchId;
  const sideA = a.last('match').side;
  lobby.message(a, { t: 'result', matchId: id, winner: sideA, checksum: 'abc' });
  lobby.message(b, { t: 'result', matchId: id, winner: sideA, checksum: 'abc' });
  const ra = a.last('matchResult');
  assert.strictEqual(ra.reason, 'complete');
  assert.ok(ra.ratingAfter > ra.ratingBefore);
  assert.ok(b.last('matchResult').ratingAfter < 1500);
  assert.strictEqual(store.get(a.id).ranked.w, 1);
  assert.strictEqual(store.get(a.id).streak, 1);
  assert.strictEqual(store.get(b.id).streak, -1);
});

test('disagreeing results are disputed and not recorded', () => {
  const { lobby, make, store } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: true });
  playToGo(lobby, a, b);
  const id = a.last('match').matchId;
  lobby.message(a, { t: 'result', matchId: id, winner: 0, checksum: 'abc' });
  lobby.message(b, { t: 'result', matchId: id, winner: 1, checksum: 'abc' });
  assert.strictEqual(a.last('matchResult').reason, 'disputed');
  assert.strictEqual(store.get(a.id).ranked.w + store.get(a.id).ranked.l, 0);
});

test('quitting a started match is a forfeit loss', () => {
  const { lobby, make, store } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: true });
  playToGo(lobby, a, b);
  lobby.disconnect(a);
  assert.strictEqual(b.last('matchResult').reason, 'forfeit');
  assert.strictEqual(b.last('opponentLeft').forfeit, true);
  assert.strictEqual(store.get(a.id).ranked.l, 1);
  assert.strictEqual(store.get(b.id).ranked.w, 1);
});

test('a match nobody loads in time is cancelled without a result', () => {
  const { lobby, make, store, advance } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: true });
  lobby.message(b, { t: 'queue', ranked: true });
  lobby.message(a, { t: 'ready' });
  advance(READY_TIMEOUT_MS + 1);
  lobby.tick();
  assert.strictEqual(a.last('opponentLeft').forfeit, false);
  assert.strictEqual(store.get(a.id).ranked.l + store.get(b.id).ranked.l, 0);
  assert.strictEqual(lobby.matches.size, 0);
});

test('private rooms: join by code, unknown codes are rejected', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'room.create' });
  const code = a.last('room').code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  lobby.message(b, { t: 'room.join', code: 'ZZZZZ' });
  assert.strictEqual(b.last('error').code, 'room_not_found');
  lobby.message(b, { t: 'room.join', code: code.toLowerCase() });
  assert.ok(a.last('match') && b.last('match'));
  assert.strictEqual(a.last('match').ranked, false);
});

test('rematch starts a fresh match when both agree', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: false });
  lobby.message(b, { t: 'queue', ranked: false });
  playToGo(lobby, a, b);
  const first = a.last('match').matchId;
  lobby.message(a, { t: 'result', matchId: first, winner: 2, checksum: 'z' });
  lobby.message(b, { t: 'result', matchId: first, winner: 2, checksum: 'z' });
  lobby.message(a, { t: 'rematch' });
  assert.ok(b.last('rematchRequested'));
  lobby.message(b, { t: 'rematch' });
  assert.notStrictEqual(a.last('match').matchId, first);
});

test('a second window with the same profile replaces the first', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const a2 = { ...a, inbox: [], sendJson(o) { this.inbox.push(o); }, close() {} };
  lobby.connect(a2);
  assert.ok(a.closed);
  assert.strictEqual(lobby.clients.get(a.id), a2);
});

test('each side is told both fighters, in side order; bad ids become the default', () => {
  const { lobby, make } = setup();
  const a = make('Alpha');
  const b = make('Bravo');
  lobby.message(a, { t: 'queue', ranked: false, fighter: 'kai' });
  lobby.message(b, { t: 'queue', ranked: false, fighter: 'DROP TABLE' });
  const ma = a.last('match');
  const mb = b.last('match');
  assert.deepStrictEqual(ma.fighters, mb.fighters);
  assert.strictEqual(ma.fighters[ma.side], 'kai');
  assert.strictEqual(ma.fighters[1 - ma.side], 'aelira');
});
