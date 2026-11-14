'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Saver, GRACE_MS, MOVE_PX } = require('../../src/core/saver');
const { createShortcuts, KEYS } = require('../../src/core/shortcuts');
const { playerPage, embedSrc, ORIGIN } = require('../../src/core/player-page');
const { DEFAULTS } = require('../../src/core/state');

test('saver ignores input for the 3 second grace period', () => {
  let t = 1000;
  const s = new Saver(() => t);
  s.enter();
  assert.equal(s.input('click'), null);
  t += GRACE_MS - 1;
  assert.equal(s.input('key'), null);
  t += 1;
  assert.equal(s.input('click'), 'click');
  assert.equal(s.input('key'), 'key');
});

test('saver ends on 120 px of deliberate movement, not on a nudge', () => {
  let t = 0;
  const s = new Saver(() => t);
  s.enter();
  t = GRACE_MS + 10;
  assert.equal(s.input('move', 50), null);
  assert.equal(s.input('move', 50), null);
  assert.equal(s.input('move', MOVE_PX), 'mouse move');
  // a nudge, then a pause of over a second, starts again from zero
  const s2 = new Saver(() => t);
  s2.enter(); t += GRACE_MS + 10;
  assert.equal(s2.input('move', 100), null);
  t += 1500;
  assert.equal(s2.input('move', 100), null);
});

test('shortcuts register the six Ctrl+Alt keys and report failures', () => {
  const taken = new Set(['Ctrl+Alt+S']);
  const handlers = {};
  const fake = {
    register(acc, fn) { if (taken.has(acc)) return false; handlers[acc] = fn; return true; },
    isRegistered(acc) { return acc in handlers; },
    unregister(acc) { delete handlers[acc]; }
  };
  const fired = [];
  const sc = createShortcuts(fake, (n) => fired.push(n));
  sc.enable();
  const info = sc.info(true);
  assert.equal(info.enabled, true);
  assert.deepEqual(info.failed, ['Ctrl+Alt+S']);
  assert.equal(info.registered.length, KEYS.length - 1);
  handlers['Ctrl+Alt+B'](); handlers['Ctrl+Alt+Left']();
  assert.deepEqual(fired, ['browser', 'prev']);
  taken.clear();
  sc.retryFailed();
  assert.deepEqual(sc.info(true).failed, []);
  assert.equal(sc.info(true).registered.length, KEYS.length);
  sc.disable();
  assert.deepEqual(sc.info(false), { enabled: false, registered: [], failed: [] });
});

test('shortcuts survive a register that throws', () => {
  const sc = createShortcuts({ register() { throw new Error('bad accelerator'); }, unregister() {} }, () => {});
  sc.enable();
  assert.equal(sc.info(true).failed.length, KEYS.length);
});

test('embed src: single video loops itself, playlist plays on, follower does neither', () => {
  const v = embedSrc('https://www.youtube.com/watch?v=_JZom_gVfuw&t=30', false);
  assert.match(v, /^https:\/\/www\.youtube\.com\/embed\/_JZom_gVfuw\?/);
  assert.match(v, /loop=1&playlist=_JZom_gVfuw/);
  assert.match(v, /start=30/);
  assert.match(v, new RegExp('origin=' + encodeURIComponent(ORIGIN)));
  const pl = embedSrc('https://www.youtube.com/watch?v=_JZom_gVfuw&list=RDabc', false);
  assert.match(pl, /list=RDabc/);
  assert.doesNotMatch(pl, /loop=1/);
  const f = embedSrc('https://www.youtube.com/watch?v=_JZom_gVfuw&list=RDabc', true);
  assert.doesNotMatch(f, /list=/);
  assert.match(embedSrc('https://www.youtube.com/playlist?list=PLxyz', false), /embed\/videoseries\?.*list=PLxyz/);
});

test('player page carries the config, the helpers the app calls, and the screensaver input hooks', () => {
  const html = playerPage('https://www.youtube.com/watch?v=_JZom_gVfuw', false, Object.assign({}, DEFAULTS, { volume: 40, dim: 20 }), { forceMute: true });
  for (const fn of ['function follow(', 'function setVol(', 'function setMuted(', 'function setLook(', 'function toggle(', 'document.title=JSON.stringify']) {
    assert.ok(html.includes(fn), fn);
  }
  const cfg = JSON.parse(html.match(/var C=(\{.*?\}),player/)[1]);
  assert.equal(cfg.volume, 40);
  assert.equal(cfg.dim, 20);
  assert.equal(cfg.muted, true, 'BSIDE_MUTE forces muted');
  assert.equal(cfg.follower, false);
  assert.ok(html.includes('bsideInput'));
  assert.ok(html.includes('<title>'));
  const f = JSON.parse(playerPage('https://youtu.be/_JZom_gVfuw', true, DEFAULTS).match(/var C=(\{.*?\}),player/)[1]);
  assert.equal(f.follower, true);
});
