'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const glicko2 = require('./glicko2');
const ranks = require('./ranks');

const NAME_RE = /^[A-Za-z0-9 _\-]{2,16}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * Guest profiles keyed by a secret token the client keeps (browser storage / PlayerPrefs).
 * Stored as one JSON file, written a moment after changes; swap for a database when accounts arrive.
 */
class Store {
  constructor(file) {
    this.file = file;
    this.players = new Map(); // id -> profile
    this.byToken = new Map(); // sha256(token) -> id
    this._saveTimer = null;
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const p of data.players || []) {
        this.players.set(p.id, p);
        this.byToken.set(p.tokenHash, p.id);
      }
    }
  }

  /** Finds the profile for a token, or creates a new guest (returning its fresh token). */
  login(token, name) {
    if (typeof token === 'string' && token.length >= 32) {
      const id = this.byToken.get(hashToken(token));
      if (id) {
        const p = this.players.get(id);
        const clean = sanitizeName(name);
        if (clean && clean !== p.name) {
          p.name = clean;
          this.changed();
        }
        return { profile: p, token };
      }
    }
    const newToken = crypto.randomBytes(24).toString('hex');
    const id = crypto.randomBytes(8).toString('hex');
    const p = {
      id,
      tokenHash: hashToken(newToken),
      name: sanitizeName(name) || 'Fighter' + (1000 + crypto.randomInt(9000)),
      created: Date.now(),
      glicko: glicko2.newRating(),
      ranked: { w: 0, l: 0, d: 0 },
      casual: { w: 0, l: 0, d: 0 },
      streak: 0, // > 0 wins in a row, < 0 losses in a row
      bestStreak: 0,
      lastPlayed: 0,
    };
    this.players.set(id, p);
    this.byToken.set(p.tokenHash, id);
    this.changed();
    return { profile: p, token: newToken };
  }

  get(id) {
    return this.players.get(id);
  }

  setName(id, name) {
    const p = this.players.get(id);
    const clean = sanitizeName(name);
    if (!p || !clean) return false;
    p.name = clean;
    this.changed();
    return true;
  }

  /**
   * Applies one finished game. winner: 0 or 1 for a side, 2 for a draw.
   * Returns per-side { before, after } display ratings (null for casual).
   */
  recordGame(idA, idB, winner, ranked) {
    const a = this.players.get(idA);
    const b = this.players.get(idB);
    if (!a || !b) return null;
    const scoreA = winner === 2 ? 0.5 : winner === 0 ? 1 : 0;
    const out = [{ before: null, after: null }, { before: null, after: null }];
    if (ranked) {
      out[0].before = ranks.displayRating(a.glicko);
      out[1].before = ranks.displayRating(b.glicko);
      const [ra, rb] = glicko2.rateGame(a.glicko, b.glicko, scoreA);
      a.glicko = ra;
      b.glicko = rb;
      out[0].after = ranks.displayRating(a.glicko);
      out[1].after = ranks.displayRating(b.glicko);
    }
    const bucket = ranked ? 'ranked' : 'casual';
    applyResult(a, bucket, scoreA);
    applyResult(b, bucket, 1 - scoreA);
    a.lastPlayed = b.lastPlayed = Date.now();
    this.changed();
    return out;
  }

  leaderboard(limit = 50) {
    return [...this.players.values()]
      .filter((p) => p.ranked.w + p.ranked.l + p.ranked.d >= ranks.PLACEMENT_GAMES)
      .sort((x, y) => y.glicko.rating - x.glicko.rating)
      .slice(0, limit)
      .map((p, i) => ({
        place: i + 1,
        name: p.name,
        rating: ranks.displayRating(p.glicko),
        tier: ranks.tierOf(p).name,
        w: p.ranked.w,
        l: p.ranked.l,
      }));
  }

  changed() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 500);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ players: [...this.players.values()] }));
    fs.renameSync(tmp, this.file);
  }
}

function applyResult(p, bucket, score) {
  if (score === 1) {
    p[bucket].w++;
    p.streak = p.streak > 0 ? p.streak + 1 : 1;
  } else if (score === 0) {
    p[bucket].l++;
    p.streak = p.streak < 0 ? p.streak - 1 : -1;
  } else {
    p[bucket].d++;
    p.streak = 0;
  }
  if (p.streak > p.bestStreak) p.bestStreak = p.streak;
}

/** What the client sees about itself (never the token hash). */
function publicProfile(p) {
  const tier = ranks.tierOf(p);
  return {
    id: p.id,
    name: p.name,
    rating: ranks.displayRating(p.glicko),
    rd: Math.round(p.glicko.rd),
    tier: tier.name,
    placement: tier.placement,
    ranked: p.ranked,
    casual: p.casual,
    streak: p.streak,
    bestStreak: p.bestStreak,
  };
}

module.exports = { Store, publicProfile, sanitizeName };
