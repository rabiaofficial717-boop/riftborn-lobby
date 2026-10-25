'use strict';

// Visible ranks. The client has the same table (Game/Online/Ranks.cs) so it can draw the
// emblem without asking the server; keep the two in step.
const TIERS = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 1300 },
  { name: 'Gold', min: 1500 },
  { name: 'Platinum', min: 1700 },
  { name: 'Diamond', min: 1900 },
  { name: 'Rift Master', min: 2100 },
];

/** Placement games before a rank is shown. */
const PLACEMENT_GAMES = 5;

function displayRating(r) {
  return Math.round(r.rating);
}

function tierOf(profile) {
  const games = profile.ranked.w + profile.ranked.l + profile.ranked.d;
  if (games < PLACEMENT_GAMES) return { name: 'Unranked', placement: PLACEMENT_GAMES - games };
  const value = displayRating(profile.glicko);
  let tier = TIERS[0];
  for (const t of TIERS) if (value >= t.min) tier = t;
  return { name: tier.name, placement: 0 };
}

module.exports = { TIERS, PLACEMENT_GAMES, displayRating, tierOf };
