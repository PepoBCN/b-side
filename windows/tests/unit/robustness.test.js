'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('../../src/core/safe-write');
const { Store } = require('../../src/core/state');
const { playerWindowOptions, panelBounds, FALLBACK_WORK_AREA } = require('../../src/core/window-options');
const { createPowerHandlers } = require('../../src/core/power');
const { installShim, removeShim, shimWithExe, MARKER } = require('../../src/core/cli-install');
const { Saver, GRACE_MS } = require('../../src/core/saver');
const { playerPage } = require('../../src/core/player-page');
const { DEFAULTS } = require('../../src/core/state');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bside-rb-')); }
const err = (code) => Object.assign(new Error(code), { code });

// A fake fs that records calls and can fail the rename a set number of times.
function fakeFs(renameFailures, code) {
  const files = new Map(), calls = [];
  let fails = renameFailures;
  return {
    files, calls,
    mkdirSync: () => calls.push('mkdir'),
    writeFileSync: (f, d) => { calls.push('write ' + path.basename(f)); files.set(f, d); },
    renameSync: (a, b) => { calls.push('rename'); if (fails-- > 0) throw err(code || 'EPERM'); files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: (f) => { calls.push('unlink ' + path.basename(f)); files.delete(f); },
    readFileSync: (f) => { if (!files.has(f)) throw err('ENOENT'); return files.get(f); }
  };
}

test('writeAtomic: normal rename', () => {
  const fs2 = fakeFs(0);
  assert.equal(writeAtomic('/d/state.json', 'x', { fs: fs2, sleep() {} }), 'rename');
  assert.equal(fs2.files.get('/d/state.json'), 'x');
  assert.equal(fs2.files.has('/d/state.json.tmp'), false);
});

test('writeAtomic: one EPERM or EBUSY is retried', () => {
  for (const code of ['EPERM', 'EBUSY']) {
    const fs2 = fakeFs(1, code);
    assert.equal(writeAtomic('/d/s.json', 'y', { fs: fs2, sleep() {} }), 'rename');
    assert.equal(fs2.calls.filter((c) => c === 'rename').length, 2);
  }
});

test('writeAtomic: two failures fall back to a direct write and the tmp file is deleted', () => {
  const fs2 = fakeFs(5);
  assert.equal(writeAtomic('/d/s.json', 'z', { fs: fs2, sleep() {} }), 'direct');
  assert.equal(fs2.files.get('/d/s.json'), 'z');
  assert.equal(fs2.files.has('/d/s.json.tmp'), false);
  assert.ok(fs2.calls.includes('unlink s.json.tmp'));
});

test('writeAtomic: another error goes straight to a direct write, without a retry', () => {
  const fs2 = fakeFs(1, 'EXDEV');
  assert.equal(writeAtomic('/d/s.json', 'q', { fs: fs2, sleep() {} }), 'direct');
  assert.equal(fs2.calls.filter((c) => c === 'rename').length, 1);
});

test('Store.save survives a failing rename (injected fs)', () => {
  const fs2 = fakeFs(9);
  const s = new Store('/d', fs2);
  s.set('volume', 12);
  assert.equal(s.save(), true);
  assert.equal(JSON.parse(fs2.files.get(path.join('/d', 'state.json'))).settings.volume, 12);
  assert.equal(new Store('/d', fs2).load().settings.volume, 12);
});

test('writeAtomic on the real disk', () => {
  const f = path.join(tmp(), 'a', 'status.json');
  assert.equal(writeAtomic(f, '{"a":1}'), 'rename');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(f + '.tmp'), false);
});

test('player window options: transparent drops the background colour, otherwise it is black', () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  const a = playerWindowOptions({ rect, session: 's', preload: 'p', transparent: false });
  assert.equal(a.backgroundColor, '#000000');
  assert.equal(a.transparent, undefined);
  const b = playerWindowOptions({ rect, session: 's', preload: 'p', transparent: true });
  assert.equal(b.transparent, true);
  assert.equal(b.backgroundColor, undefined);
  assert.equal(b.webPreferences.backgroundThrottling, false);
  assert.equal(b.skipTaskbar, true);
  assert.equal(b.frame, false);
});

test('transparent player page forces a black background in CSS', () => {
  assert.ok(playerPage('https://youtu.be/_JZom_gVfuw', false, DEFAULTS, { transparent: true }).includes('html,body,#wrap{background:#000!important}'));
  assert.ok(!playerPage('https://youtu.be/_JZom_gVfuw', false, DEFAULTS, {}).includes('#wrap{background:#000!important}'));
});

test('panel bounds: at least 400 high, at most 700, top right, and a fallback with no display', () => {
  assert.equal(panelBounds({ x: 0, y: 0, width: 1920, height: 1040 }).height, 700);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1366, height: 300 }).height, 400);
  assert.deepEqual(panelBounds({ x: 100, y: 50, width: 1000, height: 800 }), { x: 100 + 1000 - 380 - 16, y: 58, width: 380, height: 700 });
  assert.deepEqual(panelBounds(null), panelBounds(FALLBACK_WORK_AREA));
  assert.deepEqual(panelBounds({ x: 0, y: 0, width: 0, height: 0 }), panelBounds(FALLBACK_WORK_AREA));
  assert.ok(panelBounds({ x: 0, y: 0, width: 200, height: 500 }).x >= 0);
});

test('power: resume does nothing while the screen is locked', () => {
  const calls = [];
  const p = createPowerHandlers((r, on) => calls.push([r, on]));
  p.onSuspend(); p.onResume();
  assert.deepEqual(calls, [['lock', true], ['lock', false]]);
  calls.length = 0;
  p.onLock();
  assert.equal(p.isLocked(), true);
  p.onResume();
  assert.deepEqual(calls, [['lock', true]], 'resume ignored while locked');
  p.onUnlock();
  assert.equal(p.isLocked(), false);
  assert.deepEqual(calls.at(-1), ['lock', false]);
  p.onBattery(); p.onAc();
  assert.deepEqual(calls.slice(-2), [['battery', true], ['battery', false]]);
});

test('saver idle poll: under a second idle after the grace period ends it as a key, and logs the cause "key"', () => {
  let t = 0;
  const s = new Saver(() => t);
  s.enter();
  assert.equal(s.idle(0), null, 'inside the grace period');
  t = GRACE_MS + 1;
  assert.equal(s.idle(5), null, 'still idle');
  assert.equal(s.idle(0.4), 'key');
  assert.equal(s.idle('0'), 'key');
  assert.equal(s.idle(1), null);
});

const TEMPLATE = '@echo off\r\n' + MARKER + '.\r\nset "EXE_ABS="\r\nset "EXE="\r\n';

test('shim copy: absolute exe path written, CRLF kept, idempotent, update on a new path', () => {
  const dir = tmp(), src = path.join(dir, 'src.cmd'), dest = path.join(dir, 'WindowsApps');
  fs.writeFileSync(src, TEMPLATE.replace(/\r\n/g, '\n'));
  const r1 = installShim({ src, destDir: dest, exePath: 'C:\\Users\\x\\AppData\\Local\\Programs\\B-Side\\B-Side.exe' });
  assert.equal(r1.action, 'installed');
  const text = fs.readFileSync(path.join(dest, 'bside.cmd'), 'utf8');
  assert.ok(text.includes('set "EXE_ABS=C:\\Users\\x\\AppData\\Local\\Programs\\B-Side\\B-Side.exe"\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every line ends CRLF');
  assert.equal(installShim({ src, destDir: dest, exePath: 'C:\\Users\\x\\AppData\\Local\\Programs\\B-Side\\B-Side.exe' }).action, 'unchanged');
  assert.equal(installShim({ src, destDir: dest, exePath: 'D:\\Apps\\B-Side.exe' }).action, 'updated');
  assert.ok(fs.readFileSync(path.join(dest, 'bside.cmd'), 'utf8').includes('D:\\Apps\\B-Side.exe'));
});

test('shim copy never overwrites somebody else\'s bside.cmd, and removal only removes ours', () => {
  const dir = tmp(), src = path.join(dir, 'src.cmd'), dest = path.join(dir, 'bin');
  fs.mkdirSync(dest);
  fs.writeFileSync(src, TEMPLATE);
  fs.writeFileSync(path.join(dest, 'bside.cmd'), 'echo something else');
  assert.equal(installShim({ src, destDir: dest, exePath: 'x' }).action, 'skipped');
  assert.equal(removeShim({ destDir: dest }).action, 'skipped');
  assert.equal(fs.existsSync(path.join(dest, 'bside.cmd')), true);
  fs.rmSync(path.join(dest, 'bside.cmd'));
  installShim({ src, destDir: dest, exePath: 'x' });
  assert.equal(removeShim({ destDir: dest }).action, 'removed');
  assert.equal(removeShim({ destDir: dest }).action, 'none');
});

test('the real bin/bside.cmd has the EXE_ABS line and CRLF endings, and shimWithExe fills it', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'bside.cmd'), 'utf8');
  assert.ok(real.includes('\r\n'));
  assert.ok(real.includes(MARKER));
  assert.ok(shimWithExe(real, 'C:\\B.exe').includes('set "EXE_ABS=C:\\B.exe"'));
  assert.ok(real.indexOf('..\\B-Side.exe') < real.indexOf('EXE_ABS%'), 'the exe next to resources is tried before the absolute path');
  assert.ok(real.indexOf('LOCALAPPDATA%\\Programs') < real.indexOf('~$PATH'), 'then the per-user install, then PATH');
  assert.ok(real.includes('setlocal DisableDelayedExpansion'));
  assert.ok(!/EnableDelayedExpansion/.test(real));
});
