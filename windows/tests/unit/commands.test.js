'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter, parseArgv, normaliseCli } = require('../../src/core/commands');

// A fake engine that records every call.
function fake(over) {
  const calls = [];
  const st = { on: false, mode: 'wallpaper', settings: { volume: 80, muted: false }, last: null };
  const e = {
    settings: () => st.settings, isOn: () => st.on, mode: () => st.mode,
    canResume: () => !!st.last, lastUrl: () => st.last && st.last.url
  };
  ['toggle', 'play', 'next', 'prev', 'seek', 'setSetting', 'setMode', 'start', 'playClipboard', 'recent', 'forget',
   'backToBrowser', 'stop', 'showPanel', 'hidePanel', 'hotkey', 'writeStatus', 'quit', 'setError', 'pushPanel']
    .forEach((n) => { e[n] = (...a) => calls.push([n, ...a]); });
  Object.assign(e, over || {});
  return { e, calls, st };
}

test('transport commands', () => {
  const { e, calls } = fake();
  const c = createRouter(e);
  ['toggle', 'pause', 'play', 'next', 'prev', 'seek:75'].forEach(c);
  assert.deepEqual(calls.filter((x) => x[0] !== 'pushPanel'), [
    ['toggle'], ['toggle'], ['play'], ['next'], ['prev'], ['seek', 75]
  ]);
});

test('volume and mute go through setSetting like the Mac', () => {
  const { e, calls } = fake();
  const c = createRouter(e);
  ['mute', 'louder', 'quieter', 'vol:35', 'set:dim=30', 'set:fill=false'].forEach(c);
  assert.deepEqual(calls.filter((x) => x[0] === 'setSetting'), [
    ['setSetting', 'muted', true], ['setSetting', 'volume', 90], ['setSetting', 'volume', 70],
    ['setSetting', 'volume', '35'], ['setSetting', 'dim', '30'], ['setSetting', 'fill', 'false']
  ]);
});

test('set: keeps an equals sign inside the value', () => {
  const { e, calls } = fake();
  createRouter(e)('set:launchAtLogin=on');
  assert.deepEqual(calls[0], ['setSetting', 'launchAtLogin', 'on']);
});

test('wallpaper and screensaver switch mode when on, resume the last video when off', () => {
  const a = fake(); a.st.on = true;
  createRouter(a.e)('screensaver');
  assert.deepEqual(a.calls[0], ['setMode', 'screensaver']);
  const b = fake(); b.st.last = { url: 'https://youtu.be/aaaaaaaaaaa' };
  createRouter(b.e)('wallpaper');
  assert.deepEqual(b.calls[0], ['start', 'https://youtu.be/aaaaaaaaaaa', 'wallpaper']);
  const n = fake();
  createRouter(n.e)('wallpaper');
  assert.equal(n.calls.filter((x) => x[0] === 'start' || x[0] === 'setMode').length, 0);
});

test('mode:X is the same as X', () => {
  const a = fake(); a.st.on = true;
  createRouter(a.e)('mode:screensaver');
  assert.deepEqual(a.calls[0], ['setMode', 'screensaver']);
});

test('url, pasteclip, on, resume, recent, forget', () => {
  const { e, calls, st } = fake();
  st.last = { url: 'https://youtu.be/bbbbbbbbbbb' };
  const c = createRouter(e);
  c('url:https://www.youtube.com/watch?v=aaaaaaaaaaa&t=5');
  c('pasteclip'); c('on:screensaver'); c('on'); c('resume'); c('recent:2'); c('forget');
  assert.deepEqual(calls.filter((x) => x[0] !== 'pushPanel'), [
    ['start', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=5', 'wallpaper'],
    ['playClipboard', 'wallpaper'], ['playClipboard', 'screensaver'], ['playClipboard', 'wallpaper'],
    ['start', 'https://youtu.be/bbbbbbbbbbb', 'wallpaper'], ['recent', 2], ['forget']
  ]);
});

test('off, tochrome, stop, panel, hidepanel, hotkey, status, quit', () => {
  const { e, calls } = fake();
  const c = createRouter(e);
  ['off', 'tochrome', 'stop', 'panel', 'hidepanel', 'hotkey:play', 'status', 'quit'].forEach(c);
  assert.deepEqual(calls.filter((x) => x[0] !== 'pushPanel'), [
    ['backToBrowser'], ['backToBrowser'], ['stop'], ['showPanel'], ['hidePanel'], ['hotkey', 'play'], ['writeStatus'], ['quit']
  ]);
});

test('unknown commands are ignored, and the panel is refreshed after every command', () => {
  const { e, calls } = fake();
  const c = createRouter(e);
  c('nonsense'); c('');
  assert.deepEqual(calls.map((x) => x[0]), ['pushPanel', 'pushPanel']);
});

test('a throwing engine sets an error instead of crashing', () => {
  const { e, calls } = fake({ next() { throw new Error('boom'); } });
  const logs = [];
  createRouter(e, (m) => logs.push(m))('next');
  assert.equal(calls.find((x) => x[0] === 'setError')[1], 'Something went wrong: Error: boom');
  assert.match(logs[0], /command next/);
  assert.equal(calls.at(-1)[0], 'pushPanel');
});

test('parseArgv: --cmd with a value, --cmd=value, quotes, and the test hook', () => {
  const no = () => false;
  assert.deepEqual(parseArgv(['B-Side.exe', '--cmd', 'next'], no), { cmd: 'next', userDataDir: null });
  assert.equal(parseArgv(['x', '--cmd=vol:20'], no).cmd, 'vol:20');
  assert.equal(parseArgv(['x', '--cmd', '"set:dim=30"'], no).cmd, 'set:dim=30');
  assert.equal(parseArgv(['x', '--cmd', ''], no).cmd, '');
  assert.equal(parseArgv(['x', '--cmd'], no).cmd, '');
  assert.equal(parseArgv(['x', '.'], no).cmd, null);
  assert.equal(parseArgv(['x', '--user-data-dir=C:\\tmp\\b'], no).userDataDir, 'C:\\tmp\\b');
  assert.equal(parseArgv(['x', '--user-data-dir=/tmp/b', '--cmd=panel'], no).userDataDir, '/tmp/b');
  assert.equal(parseArgv(['x', '--cmd', 'vol 50'], no).cmd, 'vol 50');
});

test('parseArgv copes with the order Electron gives a second launch: switches first, words last', () => {
  const isApp = (w) => w === '/app/dir';
  assert.equal(parseArgv(['exe', '--user-data-dir=/d', '--cmd', '--allow-file-access-from-files', '/app/dir', 'status'], isApp).cmd, 'status');
  assert.equal(parseArgv(['exe', '--cmd', '--allow-file-access-from-files', 'https://youtu.be/_JZom_gVfuw'], isApp).cmd, 'https://youtu.be/_JZom_gVfuw');
  assert.equal(parseArgv(['exe', '--cmd', '--allow-file-access-from-files'], isApp).cmd, '');
});

test('normaliseCli maps the Mac CLI words onto commands', () => {
  assert.equal(normaliseCli(''), 'panel');
  assert.equal(normaliseCli('https://youtu.be/_JZom_gVfuw'), 'url:https://youtu.be/_JZom_gVfuw');
  assert.equal(normaliseCli('vol 50'), 'vol:50');
  assert.equal(normaliseCli('dim 30'), 'set:dim=30');
  assert.equal(normaliseCli('screens main'), 'set:screens=main');
  assert.equal(normaliseCli('fill off'), 'set:fill=false');
  assert.equal(normaliseCli('fill on'), 'set:fill=true');
  assert.equal(normaliseCli('on screensaver'), 'on:screensaver');
  assert.equal(normaliseCli('next'), 'next');
  assert.equal(normaliseCli('set:dim=20'), 'set:dim=20');
});
