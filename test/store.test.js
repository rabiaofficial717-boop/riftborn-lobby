'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');

test('a signed backup brings a profile back after the server forgets it', () => {
  const before = new Store(null, { secret: 's3cret' });
  const { profile, token } = before.login(null, 'Alpha');
  before.recordGame(profile.id, before.login(null, 'Bravo').profile.id, 0, true);
  const backup = before.backupOf(before.get(profile.id));

  const after = new Store(null, { secret: 's3cret' }); // restarted, empty
  const back = after.login(token, 'Alpha', backup);
  assert.strictEqual(back.token, token);
  assert.strictEqual(back.profile.id, profile.id);
  assert.strictEqual(back.profile.ranked.w, 1);
  assert.strictEqual(back.profile.glicko.rating, before.get(profile.id).glicko.rating);
  // Known from now on, without the backup.
  assert.strictEqual(after.login(token, 'Alpha').profile.id, profile.id);
});

test('backups are refused when tampered, signed elsewhere, or presented with another token', () => {
  const s = new Store(null, { secret: 's3cret' });
  const { profile, token } = s.login(null, 'Alpha');
  const backup = s.backupOf(profile);
  const other = s.login(null, 'Bravo');

  const [body, sig] = backup.split('.');
  const edited = JSON.parse(Buffer.from(body, 'base64url').toString());
  edited.ranked.w = 99;
  const forged = Buffer.from(JSON.stringify(edited)).toString('base64url') + '.' + sig;

  for (const [tok, b] of [
    [token, forged],
    [token, backup.slice(0, -2) + 'xx'],
    [other.token, backup],
    [token, 'garbage'],
    [token, 42],
  ]) {
    const fresh = new Store(null, { secret: 's3cret' });
    const res = fresh.login(tok, 'Alpha', b);
    assert.notStrictEqual(res.profile.id, profile.id);
    assert.notStrictEqual(res.token, tok, 'an unknown token gets a new guest');
  }
  assert.notStrictEqual(new Store(null, { secret: 'other' }).login(token, 'Alpha', backup).profile.id, profile.id);
});

test('without a secret there are no backups', () => {
  const s = new Store(null);
  const { profile, token } = s.login(null, 'Alpha');
  assert.strictEqual(s.backupOf(profile), null);
  assert.notStrictEqual(new Store(null).login(token, 'Alpha', 'x.y').profile.id, profile.id);
});
