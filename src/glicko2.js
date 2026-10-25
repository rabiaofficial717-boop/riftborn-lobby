'use strict';

// Glicko-2 (Glickman, 2013). Every ranked match is treated as its own rating period, which is
// the usual choice for online games: ratings move after each game instead of in batches.

const SCALE = 173.7178;
const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const DEFAULT_VOL = 0.06;
const TAU = 0.5;
const EPSILON = 0.000001;
const MIN_RD = 45;

function newRating() {
  return { rating: DEFAULT_RATING, rd: DEFAULT_RD, vol: DEFAULT_VOL };
}

function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expected(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Returns the player's new rating after one game.
 * @param {{rating:number, rd:number, vol:number}} player
 * @param {{rating:number, rd:number, vol:number}} opponent
 * @param {number} score 1 win, 0.5 draw, 0 loss
 */
function update(player, opponent, score) {
  const mu = (player.rating - DEFAULT_RATING) / SCALE;
  const phi = player.rd / SCALE;
  const muJ = (opponent.rating - DEFAULT_RATING) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const e = expected(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // New volatility: Illinois-method root finding (step 5 of the paper).
  const a = Math.log(player.vol * player.vol);
  const f = (x) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gJ * (score - e);

  return {
    rating: muNew * SCALE + DEFAULT_RATING,
    rd: Math.max(MIN_RD, Math.min(DEFAULT_RD, phiNew * SCALE)),
    vol,
  };
}

/** Rates both sides of one game at once (each uses the other's rating from before the game). */
function rateGame(a, b, scoreA) {
  return [update(a, b, scoreA), update(b, a, 1 - scoreA)];
}

module.exports = { newRating, update, rateGame, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL };
