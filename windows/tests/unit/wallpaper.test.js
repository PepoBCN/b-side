'use strict';
// Unit tests for src/win/wallpaper.js. No Windows needed: the Win32 layer is replaced by a stateful fake
// window tree (SetParent and SetWindowPos really mutate parent, rect and z-order), so verification inside
// the module reads real state. Run: cd windows && node --test tests/unit/wallpaper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wallpaperModule = require('../../src/win/wallpaper.js');
const { createWallpaper, _internals } = wallpaperModule;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOREDIRECTIONBITMAP = 0x200000;
const WS_EX_TOOLWINDOW = 0x80;
const SWP_NOSIZE = 1;
const SWP_NOMOVE = 2;
const SWP_NOZORDER = 4;
const GW = { FIRST: 0, LAST: 1, NEXT: 2, PREV: 3, CHILD: 5 };

// ---------------------------------------------------------------------------------------------
// Fake Win32
// ---------------------------------------------------------------------------------------------
class FakeWin32 {
  constructor({ primary = { w: 1920, h: 1080 } } = {}) {
    this.primary = primary;
    this.wins = new Map();
    this.top = []; // top-level windows, top of z-order first
    this.kids = new Map();
    this.next = 0x1000;
    this.errors = [];
    this.splitCalls = [];
    this.splitHandler = () => {};
    this.rejectParent = new Set(); // hwnds that SetParent refuses to adopt
    this.silentNoParent = new Set(); // hwnds whose SetParent "succeeds" but does not stick
    this.alphaSet = new Map();
    this.dpi = new Map(); // hwnd -> awareness name, default per-monitor-v2
    this.splitTimeouts = [];
    this.calls = 0; // counts SetWindowPos/SetParent so a test can prove "nothing was touched"
  }
  dpiContext(h) {
    return this.dpi.get(h) || 'per-monitor-v2';
  }
  add({ cls, parent = 0, rect = { left: 0, top: 0, right: 100, bottom: 100 }, style = 0, ex = 0, visible = true, atTop = false }) {
    const hwnd = (this.next += 0x10);
    this.wins.set(hwnd, { cls, parent, rect: { ...rect }, style: style >>> 0, ex: ex >>> 0, visible });
    const list = parent ? this._kids(parent) : this.top;
    if (atTop) list.unshift(hwnd);
    else list.push(hwnd);
    return hwnd;
  }
  _kids(p) {
    if (!this.kids.has(p)) this.kids.set(p, []);
    return this.kids.get(p);
  }
  _list(h) {
    const w = this.wins.get(h);
    return w.parent ? this._kids(w.parent) : this.top;
  }
  destroy(h) {
    for (const c of [...this._kids(h)]) this.destroy(c);
    const w = this.wins.get(h);
    if (!w) return;
    const list = w.parent ? this._kids(w.parent) : this.top;
    const i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
    this.wins.delete(h);
    this.kids.delete(h);
  }
  reparent(h, p, atTop = true) {
    const list = this._list(h);
    list.splice(list.indexOf(h), 1);
    const w = this.wins.get(h);
    w.parent = p;
    const nl = p ? this._kids(p) : this.top;
    if (atTop) nl.unshift(h);
    else nl.push(h);
  }
  // ---- facade ----
  findWindow(cls) {
    return this.top.find((h) => this.wins.get(h).cls === cls) || 0;
  }
  findWindowEx(parent, after, cls) {
    const list = parent ? this._kids(parent) : this.top;
    let i = after ? list.indexOf(after) + 1 : 0;
    if (after && i === 0) return 0;
    for (; i < list.length; i++) if (cls == null || this.wins.get(list[i]).cls === cls) return list[i];
    return 0;
  }
  enumTopLevel() {
    return [...this.top];
  }
  getClassName(h) {
    const w = this.wins.get(h);
    return w ? w.cls : '';
  }
  getParent(h) {
    const w = this.wins.get(h);
    return w ? w.parent : 0;
  }
  setParent(child, parent) {
    const w = this.wins.get(child);
    this.calls++;
    if (!w) return { ok: false, prev: 0, err: 1400 };
    if (parent && this.rejectParent.has(parent)) return { ok: false, prev: 0, err: 87 };
    const prev = w.parent;
    if (parent && this.silentNoParent.has(parent)) return { ok: true, prev, err: 0 };
    this.reparent(child, parent, true);
    return { ok: true, prev: prev || 0x10010, err: 0 };
  }
  getStyle(h) {
    return this.wins.has(h) ? this.wins.get(h).style : 0;
  }
  setStyle(h, v) {
    if (this.wins.has(h)) this.wins.get(h).style = v >>> 0;
  }
  getExStyle(h) {
    return this.wins.has(h) ? this.wins.get(h).ex : 0;
  }
  setExStyle(h, v) {
    if (this.wins.has(h)) this.wins.get(h).ex = v >>> 0;
  }
  setWindowPos(h, after, x, y, cx, cy, flags) {
    this.calls++;
    const w = this.wins.get(h);
    if (!w) return false;
    if (!(flags & SWP_NOZORDER)) {
      const list = this._list(h);
      list.splice(list.indexOf(h), 1);
      if (after === 1) list.push(h);
      else if (after === 0) list.unshift(h);
      else {
        const i = list.indexOf(after);
        if (i < 0) list.unshift(h);
        else list.splice(i + 1, 0, h);
      }
    }
    const origin = w.parent ? this.wins.get(w.parent).rect : { left: 0, top: 0 };
    const width = w.rect.right - w.rect.left;
    const height = w.rect.bottom - w.rect.top;
    const nx = flags & SWP_NOMOVE ? w.rect.left : origin.left + x;
    const ny = flags & SWP_NOMOVE ? w.rect.top : origin.top + y;
    const nw = flags & SWP_NOSIZE ? width : cx;
    const nh = flags & SWP_NOSIZE ? height : cy;
    w.rect = { left: nx, top: ny, right: nx + nw, bottom: ny + nh };
    if (flags & 0x40) w.visible = true;
    return true;
  }
  getWindowRect(h) {
    const w = this.wins.get(h);
    return w ? { ...w.rect } : null;
  }
  showWindow(h, cmd) {
    const w = this.wins.get(h);
    if (w) w.visible = cmd !== 0;
    return true;
  }
  isWindow(h) {
    return this.wins.has(h);
  }
  isWindowVisible(h) {
    for (let c = h; c; c = this.wins.get(c).parent) {
      if (!this.wins.has(c) || !this.wins.get(c).visible) return false;
    }
    return !!h;
  }
  isChild(p, h) {
    for (let c = this.wins.has(h) ? this.wins.get(h).parent : 0; c; c = this.wins.get(c).parent) if (c === p) return true;
    return false;
  }
  getWindow(h, cmd) {
    if (!this.wins.has(h)) return 0;
    if (cmd === GW.CHILD) return this._kids(h)[0] || 0;
    const list = this._list(h);
    const i = list.indexOf(h);
    if (cmd === GW.NEXT) return list[i + 1] || 0;
    if (cmd === GW.PREV) return list[i - 1] || 0;
    if (cmd === GW.FIRST) return list[0];
    if (cmd === GW.LAST) return list[list.length - 1];
    return 0;
  }
  getDesktopWindow() {
    return 0x10010;
  }
  getSystemMetrics(i) {
    return i === 0 ? this.primary.w : this.primary.h;
  }
  sendMessageTimeout(h, msg, wp, lp, flags, timeout) {
    if (msg === 0x052c) {
      this.splitCalls.push([wp, lp]);
      this.splitTimeouts.push(timeout);
      this.splitHandler(h, wp, lp);
    }
    return { ok: true, result: 0 };
  }
  setLayeredAlpha(h, alpha) {
    const w = this.wins.get(h);
    if (!w || !(w.ex & WS_EX_LAYERED)) return false;
    this.alphaSet.set(h, alpha);
    return true;
  }
  lastErrors() {
    return [];
  }
  // ---- ours ----
  addAppWindow(rect) {
    return this.add({ cls: 'Chrome_WidgetWin_1', rect, style: WS_POPUP | WS_VISIBLE, ex: 0, atTop: true });
  }
  children(h) {
    return [...this._kids(h)];
  }
}

const virtual1 = { left: 0, top: 0, right: 1920, bottom: 1080 };

/** Windows 10 / Windows 11 before 24H2. DefView lives in Progman until 0x052C moves it under a top-level WorkerW. */
function classicShell(f, { split = true, virtual = virtual1 } = {}) {
  const tray = f.add({ cls: 'Shell_TrayWnd', rect: { left: 0, top: 1040, right: 1920, bottom: 1080 } });
  const progman = f.add({ cls: 'Progman', rect: virtual });
  const defView = f.add({ cls: 'SHELLDLL_DefView', parent: progman, rect: virtual });
  f.add({ cls: 'SysListView32', parent: defView, rect: virtual });
  const shell = { tray, progman, defView, host: 0, wallpaper: 0 };
  f.splitHandler = () => {
    if (!split || shell.host) return;
    shell.host = f.add({ cls: 'WorkerW', rect: virtual, atTop: true });
    f.reparent(defView, shell.host);
    // the wallpaper WorkerW sits right below the host and above Progman
    const i = f.top.indexOf(shell.host);
    shell.wallpaper = f.add({ cls: 'WorkerW', rect: virtual });
    f.top.splice(f.top.indexOf(shell.wallpaper), 1);
    f.top.splice(i + 1, 0, shell.wallpaper);
  };
  return shell;
}

/** Windows 11 24H2+: Progman is NOREDIRECTIONBITMAP, DefView is its child, the wallpaper WorkerW is a Progman child below it. */
function raisedShell(f, { split = true, preSplit = false, stale = true, virtual = virtual1, workerOnTop = false } = {}) {
  f.add({ cls: 'Shell_TrayWnd', rect: { left: 0, top: 1040, right: 1920, bottom: 1080 } });
  const shell = { progman: 0, defView: 0, worker: 0, stale: 0 };
  if (stale) shell.stale = f.add({ cls: 'WorkerW', rect: virtual }); // stale top-level WorkerW that must be ignored
  shell.progman = f.add({ cls: 'Progman', rect: virtual, ex: WS_EX_NOREDIRECTIONBITMAP });
  shell.defView = f.add({ cls: 'SHELLDLL_DefView', parent: shell.progman, rect: virtual, ex: WS_EX_LAYERED });
  f.add({ cls: 'SysListView32', parent: shell.defView, rect: virtual });
  // tiny helper WorkerW children that must be ignored by the size filter
  f.add({ cls: 'WorkerW', parent: shell.progman, rect: { left: 0, top: 0, right: 40, bottom: 40 } });
  const makeWorker = () => {
    shell.worker = f.add({ cls: 'WorkerW', parent: shell.progman, rect: virtual, atTop: workerOnTop });
  };
  if (preSplit) makeWorker();
  f.splitHandler = () => {
    if (split && !shell.worker) makeWorker();
  };
  return shell;
}

function fakeWindow(f, rect, { onSetBounds } = {}) {
  const hwnd = f.addAppWindow(rect);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(hwnd));
  return {
    hwnd,
    destroyed: false,
    bounds: null,
    getNativeWindowHandle: () => buf,
    isDestroyed() {
      return this.destroyed;
    },
    setBounds(b) {
      this.bounds = b;
      if (onSetBounds) onSetBounds(b);
    },
  };
}

const identityScreen = { dipToScreenRect: (w, r) => ({ ...r }) };

// Virtual clock: sleep() advances it, so tests can assert how long attach() would have blocked.
function make(f, extra = {}) {
  const clock = { t: 1_000_000, slept: 0, sleeps: 0 };
  const wp = createWallpaper({
    platform: 'win32',
    api: f,
    screen: identityScreen,
    now: () => clock.t,
    sleep: (ms) => {
      clock.t += ms;
      clock.slept += ms;
      clock.sleeps++;
    },
    os: { release: () => '10.0.26100' },
    ...extra,
  });
  wp.clock = clock;
  return wp;
}

const R = (x, y, width, height) => ({ x, y, width, height });

// ---------------------------------------------------------------------------------------------
test('u32 and setBits keep WS_POPUP (0x80000000) positive and clear bits correctly', () => {
  assert.equal(_internals.u32(-2147483648), 0x80000000);
  assert.equal(_internals.u32(0x1_0000_0001), 1);
  assert.equal(_internals.u32(undefined), 0);
  const v = _internals.setBits(WS_POPUP | WS_VISIBLE, WS_CHILD, WS_POPUP);
  assert.equal(v, (WS_CHILD | WS_VISIBLE) >>> 0);
  assert.ok(v > 0);
});

test('readHwnd handles 8-byte and 4-byte native handles', () => {
  const b8 = Buffer.alloc(8);
  b8.writeBigUInt64LE(0x2a0b4cn);
  assert.equal(_internals.readHwnd({ getNativeWindowHandle: () => b8 }), 0x2a0b4c);
  const b4 = Buffer.alloc(4);
  b4.writeUInt32LE(0x1234);
  assert.equal(_internals.readHwnd({ getNativeWindowHandle: () => b4 }), 0x1234);
});

test('classifyLayout: raised beats a stale classic WorkerW', () => {
  const c = _internals.classifyLayout;
  assert.equal(c({ raisedByExStyle: true, progmanDefView: 1, progmanWorkerLayer: 0, classicWorkerW: 5 }), 'raised');
  assert.equal(c({ raisedByExStyle: false, progmanDefView: 1, progmanWorkerLayer: 9, classicWorkerW: 5 }), 'raised');
  assert.equal(c({ raisedByExStyle: false, progmanDefView: 0, progmanWorkerLayer: 0, classicWorkerW: 5 }), 'classic');
  assert.equal(c({ raisedByExStyle: false, progmanDefView: 0, progmanWorkerLayer: 0, classicWorkerW: 0 }), 'unknown');
});

test('non-windows: every function is a safe stub', () => {
  const w = createWallpaper({ platform: 'darwin' });
  assert.equal(w.supported(), false);
  assert.deepEqual(w.attach({}, R(0, 0, 10, 10)), { ok: false, method: 'none', parentClass: '', detail: 'not windows' });
  assert.doesNotThrow(() => w.detach({}));
  assert.equal(w.describe({}).isChild, false);
  assert.deepEqual(w.reattachAll(), []);
  // the default singleton behaves the same on this machine unless it is really Windows
  if (process.platform !== 'win32') assert.equal(wallpaperModule.supported(), false);
});

test('classic layout: sends 0x052C once, parents to the wallpaper WorkerW, window ends up a child', () => {
  const f = new FakeWin32();
  const shell = classicShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  const res = wp.attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.ok, true, res.detail);
  assert.equal(res.method, 'workerw');
  assert.equal(res.parentClass, 'WorkerW');
  assert.deepEqual(f.splitCalls, [[0xd, 1]]);
  assert.equal(f.getParent(win.hwnd), shell.wallpaper, 'parent is the wallpaper WorkerW, not the DefView host');
  assert.notEqual(f.getParent(win.hwnd), shell.host);
  const st = f.getStyle(win.hwnd);
  assert.ok(st & WS_CHILD, 'WS_CHILD set');
  assert.ok(!(st & WS_POPUP), 'WS_POPUP cleared');
  const d = wp.describe(win);
  assert.equal(d.parentClass, 'WorkerW');
  assert.equal(d.isChild, true);
  assert.equal(d.visible, true);
  assert.deepEqual(d.rect, { x: 0, y: 0, width: 1920, height: 1080 });
});

test('classic layout already split: no 0x052C is sent', () => {
  const f = new FakeWin32();
  const shell = classicShell(f);
  f.splitHandler(); // Explorer already did it
  f.splitCalls.length = 0;
  const win = fakeWindow(f, virtual1);
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'workerw');
  assert.equal(f.splitCalls.length, 0);
  assert.equal(f.getParent(win.hwnd), shell.wallpaper);
});

test('24H2 raised layout: layered child of Progman, directly below DefView and above the wallpaper WorkerW', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  const res = wp.attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.ok, true, res.detail);
  assert.equal(res.method, 'progman-child');
  assert.equal(res.parentClass, 'Progman');
  assert.notEqual(f.getParent(win.hwnd), shell.stale, 'the stale top-level WorkerW is never used');
  assert.deepEqual(f.splitCalls, [[0xd, 1]], 'one (0xD,1) request and no lParam=0 variant on a raised desktop');
  const kids = f.children(shell.progman);
  const oi = kids.indexOf(win.hwnd);
  assert.equal(oi, kids.indexOf(shell.defView) + 1, 'directly under DefView');
  assert.ok(kids.indexOf(shell.worker) > oi, 'wallpaper WorkerW below us');
  assert.ok(f.getExStyle(win.hwnd) & WS_EX_LAYERED, 'layered bit set');
  assert.equal(f.alphaSet.get(win.hwnd), 255);
  assert.ok(f.getStyle(win.hwnd) & WS_CHILD);
  assert.ok(!(f.getStyle(win.hwnd) & WS_POPUP));
  assert.equal(wp.describe(win).parentClass, 'Progman');
});

test('24H2 raised layout: a wallpaper WorkerW that sits above us is pushed to the bottom', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f, { preSplit: true, workerOnTop: true });
  const win = fakeWindow(f, virtual1);
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'progman-child', res.detail);
  const kids = f.children(shell.progman);
  assert.equal(kids[kids.length - 1], shell.worker, 'worker is the bottom-most child');
  assert.equal(f.splitCalls.length, 0, 'layer already existed, no split request');
});

test('24H2 raised layout where Explorer never creates the WorkerW: still tries the Progman child and says so', () => {
  const f = new FakeWin32();
  raisedShell(f, { split: false });
  const win = fakeWindow(f, virtual1);
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'progman-child', res.detail);
  assert.match(res.detail, /no wallpaper layer after split request/);
  assert.deepEqual(f.splitCalls, [[0xd, 1]], 'never the lParam=0 variant on a raised desktop');
});

test('falls through: raised layout, Progman refuses the child, WorkerW child refuses too -> bottom, desktop windows pushed below', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  f.rejectParent.add(shell.progman);
  f.rejectParent.add(shell.worker || 0);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  // make the worker exist before attach so it can be rejected too
  f.splitHandler();
  f.rejectParent.add(shell.worker);
  const res = wp.attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.ok, true, res.detail);
  assert.equal(res.method, 'bottom');
  assert.equal(res.parentClass, '');
  assert.match(res.detail, /progman-child failed/);
  assert.match(res.detail, /workerw failed/);
  assert.equal(f.getParent(win.hwnd), 0, 'top-level again');
  const st = f.getStyle(win.hwnd);
  assert.ok(st & WS_POPUP);
  assert.ok(!(st & WS_CHILD));
  assert.ok(f.getExStyle(win.hwnd) & WS_EX_TOOLWINDOW, 'tool window: no taskbar entry');
  const top = f.top;
  assert.ok(top.indexOf(win.hwnd) < top.indexOf(shell.progman), 'above Progman');
  assert.equal(top[top.length - 1], shell.progman, 'Progman at the very bottom');
});

test('falls through: SetParent reports success but does not stick (parent mismatch) -> next strategy', () => {
  const f = new FakeWin32();
  const shell = classicShell(f);
  f.splitHandler();
  f.silentNoParent.add(shell.wallpaper);
  const win = fakeWindow(f, virtual1);
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'bottom');
  assert.match(res.detail, /workerw failed \(SetParent to WorkerW did not stick/);
});

test('unknown layout (no DefView, no WorkerW at all) goes straight to the bottom fallback', () => {
  const f = new FakeWin32();
  f.add({ cls: 'Progman', rect: virtual1 });
  const win = fakeWindow(f, virtual1);
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'bottom');
  assert.equal(res.ok, true);
  assert.match(res.detail, /layout=unknown/);
});

test('total failure returns method none and never throws', () => {
  const f = new FakeWin32();
  classicShell(f);
  const wp = make(f);
  const gone = { getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), isDestroyed: () => false };
  const res = wp.attach(gone, R(0, 0, 100, 100));
  assert.equal(res.ok, false);
  assert.equal(res.method, 'none');
  assert.equal(wp.attach({ isDestroyed: () => true }, R(0, 0, 100, 100)).detail, 'window destroyed');
  assert.equal(wp.attach(fakeWindow(f, virtual1), R(0, 0, 0, 0)).detail, 'bad rect');
  // an FFI function that throws must not escape
  const bomb = new FakeWin32();
  classicShell(bomb);
  bomb.getStyle = () => {
    throw new Error('boom');
  };
  const r2 = make(bomb).attach(fakeWindow(bomb, virtual1), R(0, 0, 100, 100));
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /boom/);
});

test('detach restores a normal top-level window with its original styles', () => {
  const f = new FakeWin32();
  classicShell(f);
  const win = fakeWindow(f, virtual1);
  const before = { style: f.getStyle(win.hwnd), ex: f.getExStyle(win.hwnd) };
  const wp = make(f);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'workerw');
  wp.detach(win);
  assert.equal(f.getParent(win.hwnd), 0);
  assert.equal(f.getStyle(win.hwnd), before.style);
  assert.equal(f.getExStyle(win.hwnd), before.ex);
  assert.equal(wp.describe(win).isChild, false);
  assert.equal(wp.describe(win).parentClass, '');
});

test('DPI: uses screen.dipToScreenRect with the window already moved to the target DIP rect', () => {
  const f = new FakeWin32();
  classicShell(f, { virtual: { left: 0, top: 0, right: 1920, bottom: 1080 } });
  let movedBeforeConversion = false;
  const win = fakeWindow(f, virtual1);
  const seen = [];
  const screen = {
    dipToScreenRect(w, r) {
      movedBeforeConversion = !!win.bounds && win.bounds.width === r.width;
      seen.push(r);
      return { x: r.x * 1.5, y: r.y * 1.5, width: r.width * 1.5, height: r.height * 1.5 }; // 150% display
    },
  };
  const wp = make(f, { screen });
  const res = wp.attach(win, R(0, 0, 1280, 720));
  assert.equal(res.method, 'workerw', res.detail);
  assert.equal(movedBeforeConversion, true);
  assert.deepEqual(wp.describe(win).rect, { x: 0, y: 0, width: 1920, height: 1080 }, '1280x720 DIP at 150% is 1920x1080 physical');
  assert.match(res.detail, /dpi=dipToScreenRect/);
});

test('DPI fallback when dipToScreenRect is missing uses the matching display scale factor', () => {
  const f = new FakeWin32();
  classicShell(f);
  const win = fakeWindow(f, virtual1);
  const screen = { getDisplayMatching: () => ({ scaleFactor: 1.5 }) };
  const res = make(f, { screen }).attach(win, R(0, 0, 1280, 720));
  assert.match(res.detail, /dpi=scaleFactor 1.5/);
  assert.equal(f.getWindowRect(win.hwnd).right, 1920);
});

test('multi-display with a negative origin: child coordinates are parent-relative, screen rects stay physical', () => {
  // Left monitor 1920x1080 at x=-1920, primary 1920x1080 at 0 (150% scale on primary: 1280x720 DIP).
  const virtual = { left: -1920, top: 0, right: 1920, bottom: 1080 };
  const f = new FakeWin32();
  const shell = raisedShell(f, { virtual });
  const screen = {
    dipToScreenRect(w, r) {
      if (r.x < 0) return { x: r.x, y: r.y, width: r.width, height: r.height }; // left monitor at 100%
      return { x: r.x * 1.5, y: r.y * 1.5, width: r.width * 1.5, height: r.height * 1.5 };
    },
  };
  const wp = make(f, { screen });
  const left = fakeWindow(f, virtual1);
  const main = fakeWindow(f, virtual1);
  const a = wp.attach(left, R(-1920, 0, 1920, 1080));
  const b = wp.attach(main, R(0, 0, 1280, 720));
  assert.equal(a.method, 'progman-child', a.detail);
  assert.equal(b.method, 'progman-child', b.detail);
  assert.deepEqual(wp.describe(left).rect, { x: -1920, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(wp.describe(main).rect, { x: 0, y: 0, width: 1920, height: 1080 });
  // The fake SetWindowPos resolves child coordinates against the parent's origin, so a correct result above
  // proves we passed parent-relative numbers: left monitor -> 0, primary -> 1920.
  assert.equal(f.getWindowRect(left.hwnd).left, -1920);
  assert.equal(f.getWindowRect(main.hwnd).left, 0);
  const kids = f.children(shell.progman);
  const di = kids.indexOf(shell.defView);
  assert.ok(kids.indexOf(left.hwnd) > di && kids.indexOf(main.hwnd) > di, 'both below the icons');
  assert.ok(kids.indexOf(shell.worker) > kids.indexOf(left.hwnd) && kids.indexOf(shell.worker) > kids.indexOf(main.hwnd), 'worker below both');
});

test('explorer restart: window destroyed with its parent is reported so the caller can recreate it', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'progman-child');
  f.destroy(shell.progman); // takes our child with it
  const results = wp.reattachAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].destroyed, true);
  assert.deepEqual(wp.reattachAll(), [], 'entry dropped');
});

test('explorer restart: window survives as an orphan, reattachAll attaches it to the new Progman', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'progman-child');
  // Explorer dies: our window is un-parented (survived), Progman is gone, a fresh shell appears with new handles.
  f.reparent(win.hwnd, 0);
  f.destroy(shell.progman);
  if (shell.stale) f.destroy(shell.stale);
  const fresh = raisedShell(f);
  const results = wp.reattachAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].destroyed, false);
  assert.equal(results[0].ok, true, results[0].detail);
  assert.equal(results[0].method, 'progman-child');
  assert.equal(f.getParent(win.hwnd), fresh.progman);
  assert.equal(wp.describe(win).parentClass, 'Progman');
});

test('watch: notices a replaced Progman and calls onReattach', async () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'progman-child');
  const got = new Promise((resolve) => wp.startWatch({ intervalMs: 10, onReattach: resolve }));
  f.reparent(win.hwnd, 0);
  f.destroy(shell.progman);
  f.destroy(shell.stale);
  const fresh = raisedShell(f);
  const results = await got;
  wp.stopWatch();
  assert.equal(results[0].ok, true, results[0].detail);
  assert.equal(f.getParent(win.hwnd), fresh.progman);
});

test('watch: repairs z-order in place when Explorer raises its WorkerW above us', async () => {
  const f = new FakeWin32();
  const shell = raisedShell(f);
  const win = fakeWindow(f, virtual1);
  const wp = make(f);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'progman-child');
  f.setWindowPos(shell.worker, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); // worker to the top of Progman's children
  assert.ok(f.children(shell.progman).indexOf(shell.worker) < f.children(shell.progman).indexOf(win.hwnd));
  wp.startWatch({ intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 80));
  wp.stopWatch();
  const kids = f.children(shell.progman);
  assert.ok(kids.indexOf(shell.worker) > kids.indexOf(win.hwnd), 'worker is below us again');
});

test('every Win32 prototype string parses with the real koffi, and createApi binds them all', () => {
  let koffi;
  try {
    koffi = require('koffi');
  } catch (e) {
    return; // koffi not installed here
  }
  const bound = [];
  let seq = 0;
  const fakeKoffi = Object.create(koffi);
  fakeKoffi.load = () => ({
    func(decl) {
      koffi.proto(decl.replace(/^(\S+) __stdcall (\w+)\(/, '$1 __stdcall Decl' + ++seq + '_$2('));
      bound.push(decl);
      return () => 0;
    },
  });
  fakeKoffi.struct = koffi.struct.bind(koffi);
  fakeKoffi.proto = koffi.proto.bind(koffi);
  const api = wallpaperModule.createApi(fakeKoffi, { arch: 'x64' });
  assert.deepEqual(api.errors, [], 'no declaration failed to bind');
  assert.ok(bound.length >= 17, 'bound ' + bound.length);
  const api32 = wallpaperModule.createApi(fakeKoffi, { arch: 'ia32' });
  assert.deepEqual(api32.errors, []);
  // The facade returns neutral values instead of throwing when a call fails.
  assert.equal(api.findWindow('Progman'), 0);
  assert.equal(api.getClassName(5), '');
  assert.equal(api.isWindow(0), false);
});

test('supported() is false and attach reports why when koffi cannot be loaded on a win32 platform', () => {
  const w = createWallpaper({
    platform: 'win32',
    koffi: {
      struct() {
        throw new Error('no koffi here');
      },
      proto() {
        throw new Error('no koffi here');
      },
    },
  });
  assert.equal(w.supported(), false);
  const r = w.attach({ getNativeWindowHandle: () => Buffer.alloc(8) }, R(0, 0, 10, 10));
  assert.equal(r.ok, false);
  assert.match(r.detail, /koffi unavailable/);
  assert.equal(path.basename(__filename), 'wallpaper.test.js');
});

// ---------------------------------------------------------------------------------------------
// Review fixes: bounded blocking, remembered split failure, settled bottom fallback, DPI failure reason
// ---------------------------------------------------------------------------------------------
test('attach blocks at most 300 ms, and a missing wallpaper layer is not retried for 5 minutes (two monitors)', () => {
  const f = new FakeWin32();
  raisedShell(f, { split: false }); // Explorer never creates the WorkerW
  const wp = make(f);
  const w1 = fakeWindow(f, virtual1);
  const w2 = fakeWindow(f, virtual1);

  const r1 = wp.attach(w1, R(0, 0, 960, 1080));
  assert.equal(r1.ok, true, r1.detail);
  assert.ok(wp.clock.slept <= 300, `first attach slept ${wp.clock.slept} ms`);
  assert.ok(wp.clock.slept > 0, 'it did wait a little for the layer');
  assert.ok(f.splitTimeouts.every((t) => t <= 150), 'SendMessageTimeout timeout is short: ' + f.splitTimeouts);
  assert.match(r1.detail, /not retried for 5 min/);
  const sentAfterFirst = f.splitCalls.length;
  const sleptAfterFirst = wp.clock.slept;

  const r2 = wp.attach(w2, R(960, 0, 960, 1080));
  assert.equal(r2.ok, true, r2.detail);
  assert.equal(wp.clock.slept, sleptAfterFirst, 'second monitor does not wait at all');
  assert.equal(f.splitCalls.length, sentAfterFirst, 'no second split request');
  assert.match(r2.detail, /split skipped/);

  // reattachAll for both stays inside the cap too (re-attaches are the non-fallback progman-child entries)
  const before = wp.clock.slept;
  wp.reattachAll();
  assert.equal(wp.clock.slept, before, 'still remembered, no waiting');

  wp.clock.t += 5 * 60 * 1000 + 1; // 5 minutes later
  wp.attach(w1, R(0, 0, 960, 1080));
  assert.ok(f.splitCalls.length > sentAfterFirst, 'retried after the memory expired');
});

test('a changed Progman (Explorer restart) forgets the remembered split failure', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f, { split: false });
  const wp = make(f);
  const win = fakeWindow(f, virtual1);
  wp.attach(win, R(0, 0, 1920, 1080));
  const sent = f.splitCalls.length;
  f.reparent(win.hwnd, 0);
  f.destroy(shell.progman);
  f.destroy(shell.stale);
  raisedShell(f, { split: true });
  const res = wp.reattachAll();
  assert.ok(f.splitCalls.length > sent, 'new Progman gets a fresh split request');
  assert.equal(res[0].ok, true, res[0].detail);
  assert.ok(wp.clock.slept <= 300);
});

test('bottom fallback is settled: reattachAll and the watcher do nothing, no blocking, no z-order churn', async () => {
  const f = new FakeWin32();
  f.add({ cls: 'Progman', rect: virtual1 }); // unknown layout -> bottom
  const wp = make(f);
  const win = fakeWindow(f, virtual1);
  const res = wp.attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'bottom');
  const calls = f.calls;
  const slept = wp.clock.slept;
  const sent = f.splitCalls.length;

  wp.clock.t += 31_000; // the old code retried after 30 s
  const r = wp.reattachAll();
  assert.equal(r.length, 1);
  assert.equal(r[0].skipped, true);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].method, 'bottom');
  assert.equal(f.calls, calls, 'no SetParent/SetWindowPos issued');
  assert.equal(wp.clock.slept, slept, 'no waiting');
  assert.equal(f.splitCalls.length, sent, 'no split request');

  let fired = 0;
  wp.startWatch({ intervalMs: 10, onReattach: () => fired++ });
  await new Promise((resolve) => setTimeout(resolve, 80));
  wp.stopWatch();
  assert.equal(fired, 0, 'watcher never re-attaches a settled fallback');
  assert.equal(f.calls, calls);
});

test('bottom fallback is redone when Explorer really changed (new Progman)', () => {
  const f = new FakeWin32();
  const old = f.add({ cls: 'Progman', rect: virtual1 });
  const wp = make(f);
  const win = fakeWindow(f, virtual1);
  assert.equal(wp.attach(win, R(0, 0, 1920, 1080)).method, 'bottom');
  f.destroy(old);
  const shell = classicShell(f);
  f.splitHandler();
  const r = wp.reattachAll();
  assert.equal(r[0].skipped, undefined);
  assert.equal(r[0].method, 'workerw', r[0].detail);
  assert.equal(f.getParent(win.hwnd), shell.wallpaper);
});

test('SetParent failure is explained in detail: win32 error and a DPI awareness mismatch', () => {
  const f = new FakeWin32();
  const shell = raisedShell(f, { preSplit: true });
  f.rejectParent.add(shell.progman);
  f.rejectParent.add(shell.worker);
  const win = fakeWindow(f, virtual1);
  f.dpi.set(win.hwnd, 'per-monitor-v2');
  f.dpi.set(shell.progman, 'system');
  f.dpi.set(shell.worker, 'system');
  const res = make(f).attach(win, R(0, 0, 1920, 1080));
  assert.equal(res.method, 'bottom');
  assert.equal(res.ok, true);
  assert.match(res.detail, /SetParent to Progman did not stick/);
  assert.match(res.detail, /win32 error 87 ERROR_INVALID_PARAMETER/);
  assert.match(res.detail, /DPI awareness window=per-monitor-v2 parent=system, MISMATCH, likely cause/);
  assert.match(res.detail, /FELL BACK TO bottom because: progman-child: SetParent to Progman/);
});

test('fallback to bottom with no desktop layer says why, and describeSetParentFailure handles unknowns', () => {
  const f = new FakeWin32();
  f.add({ cls: 'Progman', rect: virtual1 });
  const res = make(f).attach(fakeWindow(f, virtual1), R(0, 0, 1920, 1080));
  assert.equal(res.method, 'bottom');
  assert.match(res.detail, /FELL BACK TO bottom because: no desktop layer found \(layout=unknown\)/);
  const d = _internals.describeSetParentFailure('WorkerW', { ok: true, prev: 0, err: 0 }, 'unknown', 'unknown');
  assert.match(d, /DPI awareness window=unknown parent=unknown/);
  assert.doesNotMatch(d, /MISMATCH/);
});
