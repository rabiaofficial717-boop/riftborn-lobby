'use strict';

const test = require('node:test');
const assert = require('node:assert');
const glicko2 = require('../src/glicko2');

test('winner gains and loser drops by the same amount between equal new players', () => {
  const [a, b] = glicko2.rateGame(glicko2.newRating(), glicko2.newRating(), 1);
  assert.ok(a.rating > 1500 && b.rating < 1500);
  assert.ok(Math.abs(a.rating - 1500 - (1500 - b.rating)) < 1e-6);
  assert.ok(a.rd < 350 && b.rd < 350, 'uncertainty shrinks after a game');
});

test('a draw between equals changes nothing but uncertainty', () => {
  const [a, b] = glicko2.rateGame(glicko2.newRating(), glicko2.newRating(), 0.5);
  assert.ok(Math.abs(a.rating - 1500) < 1e-6 && Math.abs(b.rating - 1500) < 1e-6);
});

test('upsets move ratings more than expected wins', () => {
  const strong = { rating: 1900, rd: 80, vol: 0.06 };
  const weak = { rating: 1400, rd: 80, vol: 0.06 };
  const expectedWin = glicko2.update(strong, weak, 1).rating - strong.rating;
  const upset = glicko2.update(weak, strong, 1).rating - weak.rating;
  assert.ok(upset > expectedWin * 3);
});

test('matches the Glickman paper example for its first opponent within rounding', () => {
  // Paper: player 1500/200/0.06 beats 1400/30. One-game rating period computed independently.
  const r = glicko2.update({ rating: 1500, rd: 200, vol: 0.06 }, { rating: 1400, rd: 30, vol: 0.06 }, 1);
  assert.ok(r.rating > 1560 && r.rating < 1575, 'rating ' + r.rating);
  assert.ok(r.rd > 170 && r.rd < 180, 'rd ' + r.rd);
  assert.ok(Math.abs(r.vol - 0.06) < 0.001);
});

test('rating deviation never drops below the floor', () => {
  let p = glicko2.newRating();
  const o = { rating: 1500, rd: 50, vol: 0.06 };
  for (let i = 0; i < 400; i++) p = glicko2.update(p, o, i % 2);
  assert.ok(p.rd >= 45);
});
