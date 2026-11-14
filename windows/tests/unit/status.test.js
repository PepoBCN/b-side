'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { panelState, playerErrorText } = require('../../src/core/status');
const { DEFAULTS } = require('../../src/core/state');

const base = () => ({
  now: 1000000, on: false, mode: 'wallpaper', error: null, errorAt: 0, playerError: null, pausedBy: null,
  screens: 2, current: null, main: {}, settings: Object.assign({}, DEFAULTS), recents: [], last: null,
  version: '1.0.0', players: 0, followers: [], panelOpen: false,
  shortcuts: { enabled: true, registered: ['Ctrl+Alt+B'], failed: [] },
  wallpaper: { method: 'workerw', parentClass: 'WorkerW' }, platform: 'win32'
});

const KEYS = ['on', 'mode', 'error', 'pausedBy', 'screens', 'now', 'settings', 'recents', 'canResume', 'version',
  'players', 'followers', 'panelOpen', 'shortcuts', 'wallpaper', 'platform'];

test('status has exactly the keys in PLAN.md', () => {
  assert.deepEqual(Object.keys(panelState(base())).sort(), KEYS.slice().sort());
});

test('off: now is null, canResume follows last', () => {
  const s = panelState(base());
  assert.equal(s.now, null);
  assert.equal(s.canResume, false);
  assert.equal(panelState(Object.assign(base(), { last: { url: 'x' } })).canResume, true);
});

test('playing: now carries the main player report', () => {
  const c = base();
  Object.assign(c, { on: true, current: 'https://www.youtube.com/watch?v=_JZom_gVfuw&list=RDx', players: 2,
    main: { id: '_JZom_gVfuw', title: 'T', author: 'A', t: 12, d: 200, s: 1 } });
  const s = panelState(c);
  assert.deepEqual(s.now, { id: '_JZom_gVfuw', title: 'T', author: 'A', t: 12, d: 200, playing: true, buffering: false, list: true });
  c.main.s = 3;
  assert.equal(panelState(c).now.buffering, true);
  assert.equal(panelState(c).now.playing, false);
});

test('before the player reports, now falls back to the link', () => {
  const c = Object.assign(base(), { on: true, current: 'https://youtu.be/_JZom_gVfuw' });
  const n = panelState(c).now;
  assert.equal(n.id, '_JZom_gVfuw');
  assert.equal(n.title, '');
  assert.equal(n.list, false);
});

test('an error shows for 8 seconds, then the player error takes over while playing', () => {
  const c = Object.assign(base(), { on: true, error: 'No.', errorAt: 1000000 - 3000, playerError: 'Player says no.' });
  assert.equal(panelState(c).error, 'No.');
  c.errorAt = 1000000 - 9000;
  assert.equal(panelState(c).error, 'Player says no.');
  c.on = false;
  assert.equal(panelState(c).error, null);
});

test('player error text', () => {
  assert.match(playerErrorText(150), /blocks playing it outside YouTube/);
  assert.match(playerErrorText(101), /blocks/);
  assert.match(playerErrorText(152), /blocks/);
  assert.equal(playerErrorText(153), 'YouTube could not play this video (error 153).');
  assert.equal(playerErrorText(null), null);
});

test('platform and wallpaper pass through', () => {
  const s = panelState(base());
  assert.equal(s.platform, 'win32');
  assert.deepEqual(s.wallpaper, { method: 'workerw', parentClass: 'WorkerW' });
  assert.deepEqual(s.shortcuts, { enabled: true, registered: ['Ctrl+Alt+B'], failed: [] });
});
