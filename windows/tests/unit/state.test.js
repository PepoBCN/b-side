'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, DEFAULTS, coerce, RECENTS_MAX } = require('../../src/core/state');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bside-state-')); }

test('defaults match the Mac, minus the Chrome setting', () => {
  assert.deepEqual(DEFAULTS, {
    volume: 80, muted: false, dim: 0, fill: true, screens: 'all',
    pauseOnLock: true, pauseOnBattery: false, idleSaver: 0,
    resumeOnLaunch: false, launchAtLogin: false, skipStill: true, shortcuts: true,
    cli: true, wallpaperTransparent: false
  });
});

test('coercion: booleans accept true, "true" and "on"; numbers clamp to 0..100', () => {
  assert.equal(coerce('fill', 'on'), true);
  assert.equal(coerce('fill', 'true'), true);
  assert.equal(coerce('fill', true), true);
  assert.equal(coerce('fill', 'false'), false);
  assert.equal(coerce('fill', 'off'), false);
  assert.equal(coerce('fill', 1), false);
  assert.equal(coerce('volume', 150), 100);
  assert.equal(coerce('volume', -5), 0);
  assert.equal(coerce('volume', 'abc'), 0);
  assert.equal(coerce('volume', '55'), 55);
  assert.equal(coerce('dim', '30'), 30);
  assert.equal(coerce('screens', 'main'), 'main');
  assert.equal(coerce('screens', 'weird'), 'all');
  assert.equal(coerce('nope', 1), undefined);
});

test('round trip through state.json', () => {
  const dir = tmp();
  const a = new Store(dir).load();
  assert.deepEqual(a.settings, DEFAULTS);
  a.set('volume', 33); a.set('screens', 'main'); a.set('launchAtLogin', 'true');
  a.rememberRecent('aaaaaaaaaaa', null, 'One');
  a.last = { url: 'https://youtu.be/aaaaaaaaaaa' };
  assert.equal(a.save(), true);
  const b = new Store(dir).load();
  assert.equal(b.settings.volume, 33);
  assert.equal(b.settings.screens, 'main');
  assert.equal(b.settings.launchAtLogin, true);
  assert.deepEqual(b.recents, [{ id: 'aaaaaaaaaaa', list: null, title: 'One' }]);
  assert.deepEqual(b.last, { url: 'https://youtu.be/aaaaaaaaaaa' });
});

test('a damaged or foreign state file falls back to defaults and drops unknown keys', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  assert.deepEqual(new Store(dir).load().settings, DEFAULTS);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { volume: 12, closeChromeTab: true, junk: 1 }, recents: 'x' }));
  const s = new Store(dir).load();
  assert.equal(s.settings.volume, 12);
  assert.equal('closeChromeTab' in s.settings, false);
  assert.deepEqual(s.recents, []);
});

test('recents: newest first, at most 8, no duplicates, playlists keyed by list', () => {
  const s = new Store(tmp());
  for (let i = 0; i < 12; i++) s.rememberRecent('id' + String(i).padStart(9, '0'), null, 'Track ' + i);
  assert.equal(s.recents.length, RECENTS_MAX);
  assert.equal(s.recents[0].title, 'Track 11');
  assert.equal(s.rememberRecent('id000000011', null, 'Track 11'), false, 'same top entry is not a change');
  s.rememberRecent('id000000005', null, 'Track 5 again');
  assert.equal(s.recents[0].title, 'Track 5 again');
  assert.equal(s.recents.filter((r) => r.id === 'id000000005').length, 1);
  s.rememberRecent('zzzzzzzzzzz', 'PLlist', 'A mix');
  s.rememberRecent('yyyyyyyyyyy', 'PLlist', 'A mix, next track');
  assert.equal(s.recents.filter((r) => r.list === 'PLlist').length, 1);
  s.forgetRecents();
  assert.deepEqual(s.recents, []);
});
