'use strict';

const crypto = require('crypto');
const { publicProfile } = require('./store');

const READY_TIMEOUT_MS = 30000;
const RESULT_TIMEOUT_MS = 20000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAY_MAX_BYTES = 1024;
const RELAY_MAX_PER_SECOND = 300;
const FIGHTER_RE = /^[a-z0-9_]{1,24}$/;
const DEFAULT_FIGHTER = 'aelira';

/** Roster id a client brings to matches; anything malformed becomes the default fighter. */
function cleanFighter(id) {
  return typeof id === 'string' && FIGHTER_RE.test(id) ? id : DEFAULT_FIGHTER;
}

/**
 * Everything between "connected" and "game recorded": matchmaking queues, private rooms,
 * signaling for the WebRTC connection, the relay fallback, ready/go sync, result agreement
 * and rematches. Independent of the socket library so it can be tested directly.
 *
 * A client is any object with: id, sendJson(obj), sendBinary(buffer), close().
 */
class Lobby {
  constructor(store, options = {}) {
    this.store = store;
    this.iceServers = options.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    this.now = options.now || (() => Date.now());
    this.clients = new Map(); // profile id -> client
    this.queue = []; // { client, ranked, since }
    this.rooms = new Map(); // code -> client
    this.matches = new Map(); // match id -> match
  }

  // ------------------------------------------------------------------ connections

  connect(client) {
    const old = this.clients.get(client.id);
    if (old && old !== client) {
      // Same profile opened in a second tab: the newest connection wins.
      this.disconnect(old);
      old.sendJson({ t: 'error', code: 'replaced', message: 'Signed in from another window.' });
      old.close();
    }
    client.state = 'idle';
    client.match = null;
    client.relayBudget = RELAY_MAX_PER_SECOND;
    client.relayStamp = this.now();
    this.clients.set(client.id, client);
  }

  disconnect(client) {
    if (this.clients.get(client.id) === client) this.clients.delete(client.id);
    this._leaveQueue(client);
    this._closeRoom(client);
    if (client.match) this._abandon(client);
    client.state = 'gone';
  }

  // ------------------------------------------------------------------ messages

  message(client, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'ping':
        client.sendJson({ t: 'pong', c: msg.c, online: this.clients.size });
        return;
      case 'setName':
        if (this.store.setName(client.id, msg.name)) this._sendProfile(client);
        else client.sendJson({ t: 'error', code: 'bad_name', message: 'Names are 2-16 letters, digits, spaces, _ or -.' });
        return;
      case 'profile':
        this._sendProfile(client);
        return;
      case 'leaderboard':
        client.sendJson({ t: 'leaderboard', entries: this.store.leaderboard(50) });
        return;
      case 'queue':
        client.fighter = cleanFighter(msg.fighter);
        this._enqueue(client, !!msg.ranked);
        return;
      case 'cancel':
        this._leaveQueue(client);
        this._closeRoom(client);
        if (client.state !== 'match') client.state = 'idle';
        client.sendJson({ t: 'cancelled' });
        return;
      case 'room.create':
        client.fighter = cleanFighter(msg.fighter);
        this._createRoom(client);
        return;
      case 'room.join':
        client.fighter = cleanFighter(msg.fighter);
        this._joinRoom(client, String(msg.code || '').toUpperCase());
        return;
      case 'signal':
        this._toOpponent(client, { t: 'signal', data: msg.data });
        return;
      case 'ready':
        this._ready(client, msg.delay);
        return;
      case 'result':
        this._result(client, msg);
        return;
      case 'rematch':
        this._rematch(client);
        return;
      case 'leave':
        if (client.match) this._abandon(client);
        client.state = 'idle';
        return;
      default:
        client.sendJson({ t: 'error', code: 'unknown', message: 'Unknown message ' + msg.t });
    }
  }

  /** Relay fallback: game packets go to the opponent untouched. */
  binary(client, data) {
    const m = client.match;
    if (!m || !m.started || data.length > RELAY_MAX_BYTES) return;
    const now = this.now();
    client.relayBudget = Math.min(RELAY_MAX_PER_SECOND, client.relayBudget + ((now - client.relayStamp) * RELAY_MAX_PER_SECOND) / 1000);
    client.relayStamp = now;
    if (client.relayBudget < 1) return;
    client.relayBudget--;
    const other = m.players[1 - m.players.indexOf(client)];
    if (other && other.state === 'match') other.sendBinary(data);
  }

  // ------------------------------------------------------------------ matchmaking

  _enqueue(client, ranked) {
    this._releaseFinished(client);
    if (client.state === 'match') return;
    this._leaveQueue(client);
    this._closeRoom(client);
    client.state = 'queued';
    this.queue.push({ client, ranked, since: this.now() });
    client.sendJson({ t: 'queued', ranked });
    this.tick();
  }

  _leaveQueue(client) {
    const i = this.queue.findIndex((q) => q.client === client);
    if (i >= 0) this.queue.splice(i, 1);
    if (client.state === 'queued') client.state = 'idle';
  }

  /** Pairs waiting players. Ranked pairs by rating; the allowed gap widens the longer both wait. */
  tick() {
    const now = this.now();
    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i];
      let best = -1;
      let bestGap = Infinity;
      for (let j = i + 1; j < this.queue.length; j++) {
        const b = this.queue[j];
        if (b.ranked !== a.ranked) continue;
        if (!a.ranked) {
          best = j;
          break;
        }
        const gap = Math.abs(this._rating(a.client) - this._rating(b.client));
        const waited = Math.min(now - a.since, now - b.since) / 1000;
        const allowed = Math.min(800, 150 + 30 * waited);
        if (gap <= allowed && gap < bestGap) {
          best = j;
          bestGap = gap;
        }
      }
      if (best >= 0) {
        const b = this.queue[best];
        this.queue.splice(best, 1);
        this.queue.splice(i, 1);
        i--;
        this._startMatch(a.client, b.client, a.ranked);
      }
    }
    this._checkTimeouts(now);
  }

  _rating(client) {
    const p = this.store.get(client.id);
    return p ? p.glicko.rating : 1500;
  }

  // ------------------------------------------------------------------ private rooms

  _createRoom(client) {
    this._releaseFinished(client);
    if (client.state === 'match') return;
    this._leaveQueue(client);
    this._closeRoom(client);
    let code;
    do {
      code = '';
      for (let i = 0; i < 5; i++) code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
    } while (this.rooms.has(code));
    this.rooms.set(code, client);
    client.room = code;
    client.state = 'room';
    client.sendJson({ t: 'room', code });
  }

  _joinRoom(client, code) {
    this._releaseFinished(client);
    if (client.state === 'match') return;
    const host = this.rooms.get(code);
    if (!host || host === client) {
      client.sendJson({ t: 'error', code: 'room_not_found', message: 'No room with code ' + code + '.' });
      return;
    }
    this._closeRoom(host);
    this._leaveQueue(client);
    this._closeRoom(client);
    this._startMatch(host, client, false);
  }

  _closeRoom(client) {
    if (client.room && this.rooms.get(client.room) === client) this.rooms.delete(client.room);
    client.room = null;
    if (client.state === 'room') client.state = 'idle';
  }

  // ------------------------------------------------------------------ matches

  _startMatch(a, b, ranked) {
    const m = {
      id: crypto.randomBytes(8).toString('hex'),
      ranked,
      players: [a, b],
      seed: crypto.randomInt(1, 0x7fffffff),
      ready: [false, false],
      delays: [2, 2],
      started: false,
      finished: false,
      results: [null, null],
      firstResultAt: 0,
      rematch: [false, false],
      createdAt: this.now(),
    };
    this.matches.set(m.id, m);
    for (let side = 0; side < 2; side++) {
      const c = m.players[side];
      const o = this.store.get(m.players[1 - side].id);
      c.state = 'match';
      c.match = m;
      c.sendJson({
        t: 'match',
        matchId: m.id,
        side,
        ranked,
        seed: m.seed,
        fighters: [cleanFighter(a.fighter), cleanFighter(b.fighter)],
        iceServers: this.iceServers,
        opponent: publicProfile(o),
      });
    }
  }

  /** Both loaded: start together. Each side's input delay is shared so both rollback sessions agree on it. */
  _ready(client, delay) {
    const m = client.match;
    if (!m || m.started) return;
    const side = m.players.indexOf(client);
    m.ready[side] = true;
    m.delays[side] = Number.isInteger(delay) ? Math.max(0, Math.min(6, delay)) : 2;
    if (m.ready[0] && m.ready[1]) {
      m.started = true;
      for (const c of m.players) c.sendJson({ t: 'go', matchId: m.id, delays: m.delays });
    }
  }

  _result(client, msg) {
    const m = client.match;
    if (!m || !m.started || m.finished || msg.matchId !== m.id) return;
    const winner = msg.winner;
    if (winner !== 0 && winner !== 1 && winner !== 2) return;
    const side = m.players.indexOf(client);
    m.results[side] = { winner, checksum: String(msg.checksum || '') };
    if (!m.firstResultAt) m.firstResultAt = this.now();
    const [r0, r1] = m.results;
    if (r0 && r1) {
      if (r0.winner === r1.winner && r0.checksum === r1.checksum) this._finish(m, r0.winner, 'complete');
      else this._finish(m, -1, 'disputed');
    }
  }

  /** Records the game (unless disputed) and tells both players how it went. */
  _finish(m, winner, reason) {
    if (m.finished) return;
    m.finished = true;
    const [a, b] = m.players;
    const ratings = winner >= 0 ? this.store.recordGame(a.id, b.id, winner, m.ranked) : null;
    for (let side = 0; side < 2; side++) {
      const c = m.players[side];
      if (c.state !== 'match' || c.match !== m) continue;
      const p = this.store.get(c.id);
      c.sendJson({
        t: 'matchResult',
        matchId: m.id,
        winner,
        reason,
        ranked: m.ranked,
        ratingBefore: ratings ? ratings[side].before : null,
        ratingAfter: ratings ? ratings[side].after : null,
        profile: publicProfile(p),
        backup: this.store.backupOf(p),
      });
    }
  }

  _rematch(client) {
    const m = client.match;
    if (!m || !m.finished) return;
    const side = m.players.indexOf(client);
    m.rematch[side] = true;
    const other = m.players[1 - side];
    if (other.state !== 'match' || other.match !== m) {
      client.sendJson({ t: 'opponentLeft', matchId: m.id, forfeit: false });
      return;
    }
    other.sendJson({ t: 'rematchRequested', matchId: m.id });
    if (m.rematch[0] && m.rematch[1]) {
      this.matches.delete(m.id);
      this._startMatch(m.players[0], m.players[1], m.ranked);
    }
  }

  /** A player left or dropped: an unfinished started match is a loss for them. */
  _abandon(client) {
    const m = client.match;
    client.match = null;
    if (!m) return;
    const side = m.players.indexOf(client);
    const other = m.players[1 - side];
    const forfeit = m.started && !m.finished;
    if (forfeit) this._finish(m, 1 - side, 'forfeit');
    m.finished = true;
    if (other.match === m) {
      other.sendJson({ t: 'opponentLeft', matchId: m.id, forfeit });
      other.match = null;
      other.state = 'idle';
    }
    this.matches.delete(m.id);
    if (client.state === 'match') client.state = 'idle';
  }

  /** Leaving the results screen for something else ends the old pairing. */
  _releaseFinished(client) {
    if (client.match && client.match.finished) this._abandon(client);
  }

  _checkTimeouts(now) {
    for (const m of this.matches.values()) {
      if (!m.started && now - m.createdAt > READY_TIMEOUT_MS) {
        // Someone never finished loading (or their browser could not connect at all).
        for (const c of m.players) {
          if (c.match === m) {
            c.match = null;
            c.state = 'idle';
            c.sendJson({ t: 'opponentLeft', matchId: m.id, forfeit: false });
          }
        }
        this.matches.delete(m.id);
      } else if (m.started && !m.finished && m.firstResultAt && now - m.firstResultAt > RESULT_TIMEOUT_MS) {
        // Only one side reported. Accept it: a dishonest report is caught when the other side does report.
        const r = m.results[0] || m.results[1];
        this._finish(m, r.winner, 'single_report');
      }
    }
  }

  _toOpponent(client, obj) {
    const m = client.match;
    if (!m) return;
    const other = m.players[1 - m.players.indexOf(client)];
    if (other && other.match === m) other.sendJson(obj);
  }

  _sendProfile(client) {
    const p = this.store.get(client.id);
    client.sendJson({ t: 'profile', profile: publicProfile(p), backup: this.store.backupOf(p) });
  }
}

module.exports = { Lobby, READY_TIMEOUT_MS, RESULT_TIMEOUT_MS };
