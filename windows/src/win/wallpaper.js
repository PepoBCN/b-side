'use strict';
// B-Side for Windows, lane B: put an Electron BrowserWindow behind the desktop icons.
//
// Public contract (see windows/PLAN.md):
//   supported(), attach(win, rectDip), detach(win), describe(win), reattachAll()
// Extras (not in the contract, safe to ignore): startWatch/stopWatch, inspect, dumpTree, setLogger,
// createWallpaper (factory with dependency injection, used by the unit tests), createApi.
//
// Research and the reasoning behind the strategy order is in NOTES.md next to this file.
// Everything that touches Win32 goes through a small facade ("api") so the decision logic can be unit
// tested with a fake window tree. The real facade uses koffi and is only built on win32.

const os = require('os');

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CAPTION = 0x00c00000;
const WS_SYSMENU = 0x00080000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;

const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const WS_EX_NOACTIVATE = 0x08000000;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

const HWND_TOP = 0;
const HWND_BOTTOM = 1;

const GW_HWNDFIRST = 0;
const GW_HWNDLAST = 1;
const GW_HWNDNEXT = 2;
const GW_HWNDPREV = 3;
const GW_CHILD = 5;

const SW_HIDE = 0;
const SW_SHOWNA = 8;

const LWA_ALPHA = 0x2;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const WM_SPAWN_WORKERW = 0x052c;

const MAX_BLOCK_MS = 300; // total time one attach() may block the main thread (split request plus polling)
const SPLIT_RETRY_MS = 5 * 60 * 1000; // a failed split / missing wallpaper layer is not retried for this long
const MAX_WALK = 256; // upper bound on any sibling walk, so a misbehaving tree can never loop forever

/** Win32 style values are DWORDs. JS bit ops are signed 32-bit, so always normalise. */
function u32(v) {
  try {
    return Number(BigInt.asUintN(32, BigInt(Math.trunc(Number(v) || 0))));
  } catch (_) {
    return 0;
  }
}
function setBits(v, add, remove) {
  return ((u32(v) & ~remove) | add) >>> 0;
}
const hex = (n) => '0x' + Number(n || 0).toString(16).toUpperCase();
const rectArea = (r) => (r ? Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top) : 0);

// ---------------------------------------------------------------------------------------------
// Real Win32 facade (koffi). Every call is wrapped: a failure returns a neutral value and is recorded.
// HWNDs are plain JS numbers everywhere (koffi `intptr`), never BigInt or External.
// ---------------------------------------------------------------------------------------------
const PROTOTYPES = {
  FindWindowW: 'intptr __stdcall FindWindowW(const char16_t *cls, const char16_t *title)',
  FindWindowExW: 'intptr __stdcall FindWindowExW(intptr parent, intptr after, const char16_t *cls, const char16_t *title)',
  EnumWindows: 'bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)',
  GetClassNameW: 'int __stdcall GetClassNameW(intptr hwnd, _Out_ uint8_t *buf, int max)',
  SetParent: 'intptr __stdcall SetParent(intptr child, intptr parent)',
  GetParent: 'intptr __stdcall GetParent(intptr hwnd)',
  SetWindowPos: 'bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)',
  GetWindowRect: 'bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)',
  ShowWindow: 'bool __stdcall ShowWindow(intptr hwnd, int cmd)',
  IsWindow: 'bool __stdcall IsWindow(intptr hwnd)',
  IsWindowVisible: 'bool __stdcall IsWindowVisible(intptr hwnd)',
  IsChild: 'bool __stdcall IsChild(intptr parent, intptr hwnd)',
  GetWindow: 'intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)',
  GetDesktopWindow: 'intptr __stdcall GetDesktopWindow()',
  GetSystemMetrics: 'int __stdcall GetSystemMetrics(int index)',
  SendMessageTimeoutW: 'intptr __stdcall SendMessageTimeoutW(intptr hwnd, uint32 msg, uintptr wparam, intptr lparam, uint32 flags, uint32 timeout, _Out_ uintptr *result)',
  SetLayeredWindowAttributes: 'bool __stdcall SetLayeredWindowAttributes(intptr hwnd, uint32 key, uint8 alpha, uint32 flags)',
  GetWindowLongPtrW: 'intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)',
  SetWindowLongPtrW: 'intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)',
  // DPI awareness of a window (Windows 10 1607+). Used only to explain a failed SetParent.
  GetWindowDpiAwarenessContext: 'intptr __stdcall GetWindowDpiAwarenessContext(intptr hwnd)',
  AreDpiAwarenessContextsEqual: 'bool __stdcall AreDpiAwarenessContextsEqual(intptr a, intptr b)',
  // 32-bit Windows has no *LongPtr exports (they are macros), the LongW versions are the real functions.
  GetWindowLongW: 'intptr __stdcall GetWindowLongW(intptr hwnd, int index)',
  SetWindowLongW: 'intptr __stdcall SetWindowLongW(intptr hwnd, int index, intptr value)',
};
const KERNEL32_PROTOTYPES = {
  GetLastError: 'uint32 __stdcall GetLastError()',
  SetLastError: 'void __stdcall SetLastError(uint32 code)',
};
const CALLBACK_PROTO = 'bool __stdcall EnumWindowsProc(intptr hwnd, intptr lparam)';

const typeCache = new WeakMap(); // koffi types can only be declared once per koffi instance

function declareTypes(koffi) {
  let t = typeCache.get(koffi);
  if (!t) {
    t = {
      RECT: koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }),
      EnumWindowsProc: koffi.proto(CALLBACK_PROTO),
    };
    typeCache.set(koffi, t);
  }
  return t;
}

function createApi(koffi, options = {}) {
  const arch = options.arch || process.arch;
  declareTypes(koffi);
  const user32 = koffi.load('user32.dll');
  const errors = [];
  const noteError = (name, e) => {
    errors.push(`${name}: ${e && e.message ? e.message : e}`);
    if (errors.length > 60) errors.shift();
  };
  const fn = {};
  for (const [name, decl] of Object.entries(PROTOTYPES)) {
    const is32 = arch === 'ia32';
    if (/LongPtrW$/.test(name) && is32) continue;
    if (/^(Get|Set)WindowLongW$/.test(name) && !is32) continue;
    try {
      fn[name] = user32.func(decl);
    } catch (e) {
      noteError('bind ' + name, e);
    }
  }
  const kfn = {};
  try {
    const kernel32 = koffi.load('kernel32.dll');
    for (const [name, decl] of Object.entries(KERNEL32_PROTOTYPES)) {
      try {
        kfn[name] = kernel32.func(decl);
      } catch (e) {
        noteError('bind ' + name, e);
      }
    }
  } catch (e) {
    noteError('load kernel32', e);
  }
  const getLong = fn.GetWindowLongPtrW || fn.GetWindowLongW;
  const setLong = fn.SetWindowLongPtrW || fn.SetWindowLongW;

  function guard(name, f, fallback) {
    return (...args) => {
      try {
        if (!f) throw new Error('not bound');
        return f(...args);
      } catch (e) {
        noteError(name, e);
        return fallback;
      }
    };
  }
  const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);

  const api = {
    errors,
    findWindow: (cls) => num(guard('FindWindowW', fn.FindWindowW, 0)(cls, null)),
    findWindowEx: (parent, after, cls) => num(guard('FindWindowExW', fn.FindWindowExW, 0)(parent || 0, after || 0, cls == null ? null : cls, null)),
    enumTopLevel() {
      const out = [];
      let ok = false;
      try {
        if (!fn.EnumWindows) throw new Error('not bound');
        // Transient callback: koffi unregisters it when the call returns.
        fn.EnumWindows((hwnd) => {
          out.push(num(hwnd));
          return true;
        }, 0);
        ok = true;
      } catch (e) {
        noteError('EnumWindows', e);
      }
      if (ok) return out;
      // Fallback: walk the top-level list with FindWindowExW(NULL, prev, NULL, NULL).
      const walk = [];
      let prev = 0;
      for (let i = 0; i < MAX_WALK * 8; i++) {
        const h = api.findWindowEx(0, prev, null);
        if (!h) break;
        walk.push(h);
        prev = h;
      }
      return walk;
    },
    getClassName(hwnd) {
      if (!hwnd) return '';
      try {
        const buf = Buffer.alloc(512);
        const n = fn.GetClassNameW(hwnd, buf, 256);
        return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
      } catch (e) {
        noteError('GetClassNameW', e);
        return '';
      }
    },
    getParent: (h) => num(guard('GetParent', fn.GetParent, 0)(h)),
    setParent(child, parent) {
      try {
        if (kfn.SetLastError) kfn.SetLastError(0);
        const prev = num(fn.SetParent(child, parent || 0));
        // koffi keeps GetLastError() intact between calls (changelog 2.6.10), so reading it straight after is valid.
        const err = kfn.GetLastError ? u32(kfn.GetLastError()) : 0;
        return { ok: true, prev, err };
      } catch (e) {
        noteError('SetParent', e);
        return { ok: false, prev: 0, err: 0 };
      }
    },
    dpiContext(h) {
      try {
        const ctx = fn.GetWindowDpiAwarenessContext(h);
        if (!ctx) return 'unknown';
        const eq = (v) => !!fn.AreDpiAwarenessContextsEqual(ctx, v);
        if (eq(-4)) return 'per-monitor-v2';
        if (eq(-3)) return 'per-monitor';
        if (eq(-2)) return 'system';
        if (eq(-1)) return 'unaware';
        if (eq(-5)) return 'unaware-gdiscaled';
        return 'unknown';
      } catch (e) {
        noteError('dpiContext', e);
        return 'unknown';
      }
    },
    getStyle: (h) => u32(guard('GetWindowLongPtrW', getLong, 0)(h, GWL_STYLE)),
    setStyle: (h, v) => guard('SetWindowLongPtrW', setLong, 0)(h, GWL_STYLE, u32(v)),
    getExStyle: (h) => u32(guard('GetWindowLongPtrW', getLong, 0)(h, GWL_EXSTYLE)),
    setExStyle: (h, v) => guard('SetWindowLongPtrW', setLong, 0)(h, GWL_EXSTYLE, u32(v)),
    setWindowPos: (h, after, x, y, cx, cy, flags) => !!guard('SetWindowPos', fn.SetWindowPos, false)(h, after, x, y, cx, cy, flags >>> 0),
    getWindowRect(h) {
      try {
        const r = {};
        if (!fn.GetWindowRect(h, r)) return null;
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      } catch (e) {
        noteError('GetWindowRect', e);
        return null;
      }
    },
    showWindow: (h, cmd) => !!guard('ShowWindow', fn.ShowWindow, false)(h, cmd),
    isWindow: (h) => !!h && !!guard('IsWindow', fn.IsWindow, false)(h),
    isWindowVisible: (h) => !!h && !!guard('IsWindowVisible', fn.IsWindowVisible, false)(h),
    isChild: (p, h) => !!p && !!h && !!guard('IsChild', fn.IsChild, false)(p, h),
    getWindow: (h, cmd) => num(guard('GetWindow', fn.GetWindow, 0)(h, cmd)),
    getDesktopWindow: () => num(guard('GetDesktopWindow', fn.GetDesktopWindow, 0)()),
    getSystemMetrics: (i) => num(guard('GetSystemMetrics', fn.GetSystemMetrics, 0)(i)),
    sendMessageTimeout(h, msg, wparam, lparam, flags, timeoutMs) {
      try {
        const res = [0];
        const ret = num(fn.SendMessageTimeoutW(h, msg, wparam, lparam, flags, timeoutMs, res));
        return { ok: ret !== 0, result: num(res[0]) };
      } catch (e) {
        noteError('SendMessageTimeoutW', e);
        return { ok: false, result: 0 };
      }
    },
    setLayeredAlpha: (h, alpha) => !!guard('SetLayeredWindowAttributes', fn.SetLayeredWindowAttributes, false)(h, 0, alpha, LWA_ALPHA),
    lastErrors: () => errors.slice(-8),
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------
/** Classify the shell layout from observable facts. Raised wins over classic: on a raised desktop a stale
 *  top-level WorkerW can exist, and parenting there passes every parent/class check but is never drawn. */
function classifyLayout({ raisedByExStyle, progmanDefView, progmanWorkerLayer, classicWorkerW }) {
  if (raisedByExStyle) return 'raised';
  if (progmanDefView && progmanWorkerLayer) return 'raised';
  if (classicWorkerW) return 'classic';
  return 'unknown';
}

function windowsBuild(osMod) {
  try {
    const parts = String((osMod || os).release()).split('.');
    return Number(parts[2]) || 0;
  } catch (_) {
    return 0;
  }
}

const WIN32_ERRORS = { 5: 'ERROR_ACCESS_DENIED', 87: 'ERROR_INVALID_PARAMETER', 1400: 'ERROR_INVALID_WINDOW_HANDLE', 1411: 'ERROR_CLASS_DOES_NOT_EXIST' };

/** Why SetParent did not stick, in words for the log and status.json. A DPI awareness mismatch between the
 *  Electron window and the Explorer window it is parented into is a documented way for SetParent to fail
 *  (usually ERROR_INVALID_PARAMETER, 87), so both contexts are reported. */
function describeSetParentFailure(targetClass, sp, dpiChild, dpiParent) {
  const err = sp && sp.err ? ` win32 error ${sp.err}${WIN32_ERRORS[sp.err] ? ' ' + WIN32_ERRORS[sp.err] : ''};` : '';
  const known = (d) => d && d !== 'unknown';
  const mismatch = known(dpiChild) && known(dpiParent) && dpiChild !== dpiParent;
  return `SetParent to ${targetClass} did not stick (call ok=${!!(sp && sp.ok)}, returned ${sp ? sp.prev : 0});${err} DPI awareness window=${dpiChild || 'unknown'} parent=${dpiParent || 'unknown'}${mismatch ? ', MISMATCH, likely cause' : ''}`;
}

function readHwnd(win) {
  if (win == null) return 0;
  if (typeof win === 'number') return win;
  if (typeof win.getNativeWindowHandle !== 'function') return Number(win.hwnd) || 0;
  const buf = win.getNativeWindowHandle();
  if (!buf || !buf.length) return 0;
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
  return buf.readUInt32LE(0);
}

function isGone(win) {
  try {
    return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());
  } catch (_) {
    return true;
  }
}

function defaultSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------------------------
function createWallpaper(deps = {}) {
  const platform = deps.platform || process.platform;
  let log = deps.log || ((...a) => (process.env.BSIDE_WALLPAPER_DEBUG ? console.error('[wallpaper]', ...a) : undefined));
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || Date.now;
  let splitFailure = { progman: 0, until: 0 }; // remembered "Explorer did not give us a wallpaper layer"
  const osMod = deps.os || os;

  let api = deps.api || null;
  let loadError = '';
  function getApi() {
    if (api) return api;
    if (platform !== 'win32') return null;
    try {
      const koffi = deps.koffi || require('koffi');
      api = createApi(koffi);
      return api;
    } catch (e) {
      loadError = e && e.message ? e.message : String(e);
      return null;
    }
  }
  function getScreen() {
    if (deps.screen) return deps.screen;
    try {
      return require('electron').screen;
    } catch (_) {
      return null;
    }
  }

  const NOT_WINDOWS = () => ({ ok: false, method: 'none', parentClass: '', detail: 'not windows' });
  const entries = new Map(); // hwnd -> entry
  let watchTimer = null;

  function supported() {
    return platform === 'win32' && !!getApi();
  }

  // ---- geometry ------------------------------------------------------------------------------
  /** DIP rect (Electron screen coordinates) to physical pixels. Prefers screen.dipToScreenRect, which handles
   *  per-monitor DPI and monitors at negative origins. Falls back to the matching display's scale factor. */
  function toPhysicalRect(win, rectDip, opts, notes) {
    const rd = {
      x: Math.round(rectDip.x),
      y: Math.round(rectDip.y),
      width: Math.round(rectDip.width),
      height: Math.round(rectDip.height),
    };
    // dipToScreenRect sizes the rect with the scale factor of the monitor the window is on right now, so move
    // the (still top-level) window onto the target display first.
    if (!(opts && opts.skipSetBounds) && win && typeof win.setBounds === 'function') {
      try {
        win.setBounds(rd);
      } catch (e) {
        notes.push('setBounds failed: ' + e.message);
      }
    }
    const scr = getScreen();
    let r = null;
    try {
      if (scr && typeof scr.dipToScreenRect === 'function') {
        r = scr.dipToScreenRect(win, rd);
        notes.push('dpi=dipToScreenRect');
      }
    } catch (e) {
      notes.push('dipToScreenRect failed: ' + e.message);
    }
    if (!r && scr && typeof scr.getDisplayMatching === 'function') {
      try {
        const sf = Number(scr.getDisplayMatching(rd).scaleFactor) || 1;
        r = { x: rd.x * sf, y: rd.y * sf, width: rd.width * sf, height: rd.height * sf };
        notes.push('dpi=scaleFactor ' + sf + ' (approximate)');
      } catch (e) {
        notes.push('getDisplayMatching failed: ' + e.message);
      }
    }
    if (!r) {
      r = rd;
      notes.push('dpi=identity');
    }
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  }

  // ---- shell snapshot -----------------------------------------------------------------------
  function takeSnapshot() {
    const A = getApi();
    const s = {
      progman: 0,
      progmanExStyle: 0,
      raisedByExStyle: false,
      progmanRect: null,
      refArea: 0,
      progmanDefView: 0,
      progmanWorkers: [],
      progmanWorkerLayer: 0,
      classicHosts: [],
      classicWorkerW: 0,
      defView: 0,
      hasLayer: false,
      layout: 'unknown',
    };
    s.progman = A.findWindow('Progman');
    if (!s.progman) return s;
    s.progmanExStyle = A.getExStyle(s.progman);
    s.raisedByExStyle = (s.progmanExStyle & WS_EX_NOREDIRECTIONBITMAP) !== 0;
    s.progmanRect = A.getWindowRect(s.progman);
    const primary = A.getSystemMetrics(SM_CXSCREEN) * A.getSystemMetrics(SM_CYSCREEN);
    s.refArea = primary > 0 ? primary : rectArea(s.progmanRect);

    s.progmanDefView = A.findWindowEx(s.progman, 0, 'SHELLDLL_DefView');
    // Explorer keeps several tiny WorkerW helper windows. The wallpaper layer is the one that covers the screen.
    let c = 0;
    let best = null;
    for (let i = 0; i < 32; i++) {
      c = A.findWindowEx(s.progman, c, 'WorkerW');
      if (!c) break;
      const area = rectArea(A.getWindowRect(c));
      s.progmanWorkers.push({ hwnd: c, area });
      if (!best || area > best.area) best = { hwnd: c, area };
    }
    if (best && s.refArea > 0 && best.area >= s.refArea * 0.9) s.progmanWorkerLayer = best.hwnd;

    // Classic: some top-level window hosts SHELLDLL_DefView, and the wallpaper WorkerW is the next top-level WorkerW.
    for (const top of A.enumTopLevel()) {
      const dv = A.findWindowEx(top, 0, 'SHELLDLL_DefView');
      if (!dv) continue;
      const w = A.findWindowEx(0, top, 'WorkerW');
      const area = w ? rectArea(A.getWindowRect(w)) : 0;
      s.classicHosts.push({ host: top, defView: dv, workerW: w, area });
      if (w && s.refArea > 0 && area >= s.refArea * 0.9) s.classicWorkerW = w;
    }
    s.defView = s.progmanDefView || (s.classicHosts[0] && s.classicHosts[0].defView) || 0;
    s.layout = classifyLayout(s);
    s.hasLayer = s.layout === 'raised' ? !!s.progmanWorkerLayer : !!s.classicWorkerW;
    return s;
  }

  /** Ask Explorer to split the desktop (create the wallpaper WorkerW). Sent only when no layer exists.
   *  attach() stays synchronous, so the whole wait is capped at MAX_BLOCK_MS per call, and a failure is
   *  remembered for SPLIT_RETRY_MS (per Progman, so an Explorer restart retries at once). */
  function ensureSplit(snap, notes, deadline) {
    const A = getApi();
    if (!snap.progman) return snap;
    if (snap.hasLayer) {
      splitFailure = { progman: 0, until: 0 };
      return snap;
    }
    if (splitFailure.progman === snap.progman && now() < splitFailure.until) {
      notes.push(`split skipped, no wallpaper layer earlier (retry in ${Math.ceil((splitFailure.until - now()) / 1000)}s)`);
      return snap;
    }
    const remaining = () => Math.max(0, deadline - now());
    const poll = () => {
      let s = takeSnapshot();
      while (!s.hasLayer && remaining() > 0) {
        sleep(Math.min(50, remaining()));
        s = takeSnapshot();
      }
      return s;
    };
    // SMTO_ABORTIFHUNG (2) so a hung Explorer cannot hold us for the whole timeout.
    const r1 = A.sendMessageTimeout(snap.progman, WM_SPAWN_WORKERW, 0xd, 1, 2, Math.max(1, Math.min(150, remaining())));
    notes.push(`0x052C(0xD,1) ${r1.ok ? 'sent' : 'no reply'}`);
    let s = poll();
    if (!s.hasLayer && s.layout !== 'raised' && remaining() > 0) {
      // Legacy variant. Never sent on a raised desktop, where an lParam=0 request can release the split.
      const r2 = A.sendMessageTimeout(snap.progman, WM_SPAWN_WORKERW, 0, 0, 2, Math.max(1, Math.min(100, remaining())));
      notes.push(`0x052C(0,0) ${r2.ok ? 'sent' : 'no reply'}`);
      s = poll();
    }
    if (s.hasLayer) {
      splitFailure = { progman: 0, until: 0 };
      notes.push('wallpaper layer appeared');
    } else {
      splitFailure = { progman: snap.progman, until: now() + SPLIT_RETRY_MS };
      notes.push(`no wallpaper layer after split request (not retried for ${SPLIT_RETRY_MS / 60000} min)`);
    }
    return s;
  }

  // ---- window styling and placement -----------------------------------------------------------
  function prepareChild(entry, { layered }) {
    const A = getApi();
    const h = entry.hwnd;
    // SetParent does not touch WS_CHILD/WS_POPUP. A popup becoming a child needs WS_POPUP cleared and WS_CHILD set first.
    A.setStyle(
      h,
      setBits(
        A.getStyle(h),
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
      )
    );
    let ex = setBits(A.getExStyle(h), WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, WS_EX_APPWINDOW);
    if (layered) ex = setBits(ex, WS_EX_LAYERED, 0);
    A.setExStyle(h, ex);
    // The layered bit must be in place, with constant alpha 255, BEFORE SetParent on a raised desktop.
    if (layered) A.setLayeredAlpha(h, 255);
    A.setWindowPos(h, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }

  function restoreTopLevel(entry) {
    const A = getApi();
    const h = entry.hwnd;
    if (!A.isWindow(h)) return;
    A.setParent(h, 0);
    // Opposite of the pre-SetParent rule: after un-parenting, clear WS_CHILD and restore WS_POPUP etc.
    A.setStyle(h, entry.saved.style);
    A.setExStyle(h, entry.saved.exStyle);
    A.setWindowPos(h, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }

  function childList(parent) {
    const A = getApi();
    const out = [];
    let c = A.getWindow(parent, GW_CHILD);
    for (let i = 0; c && i < MAX_WALK; i++) {
      out.push(c);
      c = A.getWindow(c, GW_HWNDNEXT);
    }
    return out; // top to bottom
  }

  function placeChild(entry, parent, insertAfter) {
    const A = getApi();
    const pr = A.getWindowRect(parent);
    const ox = pr ? pr.left : 0;
    const oy = pr ? pr.top : 0;
    const p = entry.phys;
    // Child coordinates are relative to the parent's client origin. Progman/WorkerW start at the virtual-desktop
    // origin, which is negative when a monitor sits left of or above the primary one.
    const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
    A.setWindowPos(entry.hwnd, insertAfter, p.x - ox, p.y - oy, p.width, p.height, flags);
    A.showWindow(entry.hwnd, SW_SHOWNA);
    entry.childRect = { x: p.x - ox, y: p.y - oy, width: p.width, height: p.height };
  }

  function pushToBottom(hwnd) {
    getApi().setWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  /** Raised layout: keep the wallpaper WorkerW below our window. Returns true if it had to move it. */
  function repairRaisedOrder(entry, snap) {
    const A = getApi();
    const worker = (snap && snap.progmanWorkerLayer) || entry.workerLayer;
    if (!worker || !A.isWindow(worker)) return false;
    const kids = childList(entry.parentHwnd);
    const wi = kids.indexOf(worker);
    const oi = kids.indexOf(entry.hwnd);
    if (wi >= 0 && oi >= 0 && wi < oi) {
      pushToBottom(worker);
      return true;
    }
    return false;
  }

  function verifyChild(entry, expectedClass, raisedChecks) {
    const A = getApi();
    const why = [];
    const h = entry.hwnd;
    if (!A.isWindow(h)) return { ok: false, why: ['window gone'] };
    const parent = A.getParent(h);
    if (parent !== entry.parentHwnd) why.push(`GetParent=${hex(parent)} expected ${hex(entry.parentHwnd)}`);
    const cls = parent ? A.getClassName(parent) : '';
    if (cls !== expectedClass) why.push(`parent class "${cls}" expected "${expectedClass}"`);
    if (!A.isWindowVisible(h)) why.push('not visible');
    const r = A.getWindowRect(h);
    const p = entry.phys;
    if (!r) why.push('no rect');
    else {
      const w = r.right - r.left;
      const hh = r.bottom - r.top;
      if (w < p.width * 0.9 || hh < p.height * 0.9) why.push(`size ${w}x${hh} below target ${p.width}x${p.height}`);
      if (Math.abs(r.left - p.x) > 4 || Math.abs(r.top - p.y) > 4) why.push(`origin ${r.left},${r.top} expected ${p.x},${p.y}`);
    }
    if (raisedChecks) {
      if ((A.getExStyle(h) & WS_EX_LAYERED) === 0) why.push('WS_EX_LAYERED missing');
      const kids = childList(entry.parentHwnd);
      const oi = kids.indexOf(h);
      if (oi < 0) why.push('not in Progman child list');
      if (entry.defView) {
        const di = kids.indexOf(entry.defView);
        if (di >= 0 && oi !== di + 1) why.push(`z-order: ours at ${oi}, DefView at ${di}`);
      }
      if (entry.workerLayer && A.isWindow(entry.workerLayer)) {
        const wi = kids.indexOf(entry.workerLayer);
        if (wi >= 0 && wi < oi) why.push('wallpaper WorkerW is above our window');
      }
    }
    return { ok: why.length === 0, why, parentClass: cls };
  }

  // ---- strategies -----------------------------------------------------------------------------
  function strategyProgmanChild(entry, snap) {
    const A = getApi();
    if (!snap.progman) return { ok: false, why: ['no Progman'] };
    prepareChild(entry, { layered: true });
    const sp = A.setParent(entry.hwnd, snap.progman);
    entry.parentHwnd = snap.progman;
    entry.defView = snap.progmanDefView;
    entry.workerLayer = snap.progmanWorkerLayer;
    if (A.getParent(entry.hwnd) !== snap.progman) {
      return { ok: false, why: [describeSetParentFailure('Progman', sp, A.dpiContext ? A.dpiContext(entry.hwnd) : '', A.dpiContext ? A.dpiContext(snap.progman) : '')] };
    }
    // insert-after DefView puts us directly below the icons and above the wallpaper WorkerW.
    placeChild(entry, snap.progman, snap.progmanDefView || HWND_TOP);
    A.setLayeredAlpha(entry.hwnd, 255);
    repairRaisedOrder(entry, snap);
    let v = verifyChild(entry, 'Progman', true);
    if (!v.ok) {
      // one repair pass: re-assert z-order and size, then re-check
      placeChild(entry, snap.progman, snap.progmanDefView || HWND_TOP);
      repairRaisedOrder(entry, snap);
      v = verifyChild(entry, 'Progman', true);
    }
    return v;
  }

  function strategyWorkerW(entry, snap, workerW, layered) {
    const A = getApi();
    if (!workerW) return { ok: false, why: ['no WorkerW'] };
    prepareChild(entry, { layered });
    const sp = A.setParent(entry.hwnd, workerW);
    entry.parentHwnd = workerW;
    entry.defView = 0;
    entry.workerLayer = 0;
    if (A.getParent(entry.hwnd) !== workerW) {
      return { ok: false, why: [describeSetParentFailure('WorkerW', sp, A.dpiContext ? A.dpiContext(entry.hwnd) : '', A.dpiContext ? A.dpiContext(workerW) : '')] };
    }
    placeChild(entry, workerW, HWND_TOP);
    return verifyChild(entry, 'WorkerW', false);
  }

  function strategyBottom(entry, snap, opts) {
    const A = getApi();
    const h = entry.hwnd;
    // Plain top-level window: popup, tool window (no taskbar entry), never activated.
    restoreTopLevel(entry);
    let ex = setBits(A.getExStyle(h), WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, WS_EX_APPWINDOW);
    if (opts && opts.clickThrough) ex = setBits(ex, WS_EX_LAYERED | WS_EX_TRANSPARENT, 0);
    A.setExStyle(h, ex);
    if (opts && opts.clickThrough) A.setLayeredAlpha(h, 255);
    const p = entry.phys;
    A.setWindowPos(h, HWND_BOTTOM, p.x, p.y, p.width, p.height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    A.showWindow(h, SW_SHOWNA);
    // HWND_BOTTOM alone would put us under the desktop windows and hide us. Push the desktop windows below us.
    const s = snap && snap.progman ? snap : takeSnapshot();
    const wallpaperWorkers = [];
    for (const hh of s.classicHosts || []) if (hh.workerW) wallpaperWorkers.push(hh.workerW);
    if (s.progmanWorkerLayer) wallpaperWorkers.push(s.progmanWorkerLayer);
    for (const w of wallpaperWorkers) pushToBottom(w);
    if (s.progman) pushToBottom(s.progman);
    entry.parentHwnd = 0;
    const why = [];
    if (!A.isWindowVisible(h)) why.push('not visible');
    if (A.getParent(h) !== 0) why.push('still has a parent');
    return { ok: why.length === 0, why, parentClass: '' };
  }

  function makeEntry(win, hwnd, rectDip, opts, notes) {
    const A = getApi();
    return {
      win,
      hwnd,
      rectDip: { ...rectDip },
      opts: opts || {},
      phys: toPhysicalRect(win, rectDip, opts, notes),
      saved: { style: A.getStyle(hwnd), exStyle: A.getExStyle(hwnd) },
      method: 'none',
      parentHwnd: 0,
      parentClass: '',
      defView: 0,
      workerLayer: 0,
      progman: 0,
      layout: 'unknown',
      attachedAt: now(),
      fallbackReason: '',
    };
  }

  // ---- public: attach -------------------------------------------------------------------------
  function attach(win, rectDip, opts) {
    if (platform !== 'win32') return NOT_WINDOWS();
    const A = getApi();
    if (!A) return { ok: false, method: 'none', parentClass: '', detail: 'koffi unavailable: ' + loadError };
    const notes = [];
    let entry = null;
    try {
      if (isGone(win)) return { ok: false, method: 'none', parentClass: '', detail: 'window destroyed' };
      if (!rectDip || !(rectDip.width > 0) || !(rectDip.height > 0)) {
        return { ok: false, method: 'none', parentClass: '', detail: 'bad rect' };
      }
      const hwnd = readHwnd(win);
      if (!hwnd || !A.isWindow(hwnd)) return { ok: false, method: 'none', parentClass: '', detail: 'no native window handle' };
      if (entries.has(hwnd)) {
        // Re-attach: put the window back to a normal top-level first so DPI/bounds are computed from a clean state.
        restoreTopLevel(entries.get(hwnd));
        entries.delete(hwnd);
      }
      entry = makeEntry(win, hwnd, rectDip, opts, notes);
      let snap = takeSnapshot();
      snap = ensureSplit(snap, notes, now() + MAX_BLOCK_MS);
      entry.progman = snap.progman;
      entry.layout = snap.layout;
      notes.unshift(`build=${windowsBuild(osMod)} layout=${snap.layout} raisedEx=${snap.raisedByExStyle}`);

      const plan = [];
      if (snap.layout === 'raised') {
        plan.push(['progman-child', () => strategyProgmanChild(entry, snap)]);
        if (snap.progmanWorkerLayer) plan.push(['workerw', () => strategyWorkerW(entry, snap, snap.progmanWorkerLayer, false)]);
      } else if (snap.layout === 'classic') {
        plan.push(['workerw', () => strategyWorkerW(entry, snap, snap.classicWorkerW, false)]);
      }
      if (snap.layout === 'unknown') notes.push('no desktop layer found (layout=unknown), nothing to parent into');
      plan.push(['bottom', () => strategyBottom(entry, snap, opts)]);
      const failures = [];

      for (const [method, run] of plan) {
        let res;
        try {
          res = run();
        } catch (e) {
          res = { ok: false, why: ['exception: ' + (e && e.message ? e.message : e)] };
        }
        if (res.ok) {
          entry.method = method;
          entry.parentClass = res.parentClass || '';
          entry.attachedAt = now();
          if (method === 'bottom') {
            // Say why we are not embedded, so the log and status.json explain it.
            entry.fallbackReason = failures.length ? failures.join(' | ') : notes.filter((n) => /^(no desktop layer found|split skipped)/.test(n)).join(' | ') || 'no usable desktop layer';
            notes.push('FELL BACK TO bottom because: ' + entry.fallbackReason);
          }
          entries.set(hwnd, entry);
          notes.push(`${method} ok`);
          log('attach', method, notes.join('; '));
          return { ok: true, method, parentClass: entry.parentClass, detail: notes.join('; ') };
        }
        notes.push(`${method} failed (${res.why.join(', ')})`);
        failures.push(`${method}: ${res.why.join(', ')}`);
        // Undo before the next strategy so the next one starts from a clean top-level window.
        if (method !== 'bottom') restoreTopLevel(entry);
      }
      restoreTopLevel(entry);
      log('attach failed', notes.join('; '));
      return { ok: false, method: 'none', parentClass: '', detail: notes.join('; ') };
    } catch (e) {
      notes.push('exception: ' + (e && e.message ? e.message : e));
      try {
        if (entry) restoreTopLevel(entry);
      } catch (_) {
        /* ignore */
      }
      log('attach exception', notes.join('; '));
      return { ok: false, method: 'none', parentClass: '', detail: notes.join('; ') };
    }
  }

  // ---- public: detach / describe --------------------------------------------------------------
  function detach(win) {
    if (platform !== 'win32') return;
    try {
      const A = getApi();
      if (!A) return;
      const hwnd = readHwnd(win);
      const entry = entries.get(hwnd);
      if (entry) {
        restoreTopLevel(entry);
        entries.delete(hwnd);
      } else if (hwnd && A.isWindow(hwnd) && A.getParent(hwnd)) {
        // Not tracked by us (e.g. attached by an earlier module instance): still un-parent it.
        A.setParent(hwnd, 0);
        A.setStyle(hwnd, setBits(A.getStyle(hwnd), WS_POPUP, WS_CHILD));
        A.setWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      }
    } catch (e) {
      log('detach exception', e && e.message);
    }
  }

  function describe(win) {
    const empty = { parentClass: '', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, isChild: false };
    if (platform !== 'win32') return empty;
    try {
      const A = getApi();
      if (!A || isGone(win)) return empty;
      const hwnd = readHwnd(win);
      if (!hwnd || !A.isWindow(hwnd)) return empty;
      const parent = A.getParent(hwnd);
      const r = A.getWindowRect(hwnd);
      const entry = entries.get(hwnd);
      return {
        parentClass: parent ? A.getClassName(parent) : '',
        visible: A.isWindowVisible(hwnd),
        rect: r ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : empty.rect,
        isChild: !!parent && A.isChild(parent, hwnd),
        hwnd,
        method: entry ? entry.method : 'none',
        layout: entry ? entry.layout : 'unknown',
      };
    } catch (e) {
      return empty;
    }
  }

  // ---- public: reattachAll / health / watch ---------------------------------------------------
  /** True when an entry no longer matches the shell (parent destroyed, Explorer restarted, never got a real parent). */
  function needsReattach(entry) {
    const A = getApi();
    if (!A.isWindow(entry.hwnd)) return true;
    // A window in the settled 'bottom' fallback is only redone when Explorer itself changed (new Progman).
    // No periodic retry: that blocked the main thread every 30 s.
    if (A.findWindow('Progman') !== entry.progman) return true;
    if (entry.method === 'bottom') return false;
    if (!A.isWindow(entry.parentHwnd)) return true;
    if (A.getParent(entry.hwnd) !== entry.parentHwnd) return true;
    return false;
  }

  /** Cheap in-place repair (no reattach): restore z-order if Explorer put its WorkerW above us. */
  function repairInPlace(entry) {
    if (entry.method !== 'progman-child') return false;
    const snap = takeSnapshot();
    if (!snap.progman) return false;
    if (snap.progmanWorkerLayer) entry.workerLayer = snap.progmanWorkerLayer;
    const moved = repairRaisedOrder(entry, snap);
    if (snap.progmanDefView) {
      const kids = childList(entry.parentHwnd);
      const di = kids.indexOf(snap.progmanDefView);
      const oi = kids.indexOf(entry.hwnd);
      if (di >= 0 && oi >= 0 && oi !== di + 1) {
        getApi().setWindowPos(entry.hwnd, snap.progmanDefView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        return true;
      }
    }
    return moved;
  }

  /** Re-run attach for every tracked window (display change, Explorer restart). Returns one result per window.
   *  `destroyed: true` means the native window is gone (a child dies with its parent): the caller must recreate it. */
  function reattachAll() {
    if (platform !== 'win32') return [];
    const results = [];
    const A = getApi();
    if (!A) return results;
    for (const [hwnd, entry] of Array.from(entries.entries())) {
      try {
        if (isGone(entry.win) || !A.isWindow(hwnd)) {
          entries.delete(hwnd);
          results.push({ win: entry.win, ok: false, destroyed: true, method: 'none', parentClass: '', detail: 'native window destroyed (Explorer restart?), recreate it' });
          continue;
        }
        if (entry.method === 'bottom' && !needsReattach(entry)) {
          // Already in its settled fallback state: do nothing (no re-attach, no waiting, no z-order churn).
          results.push({ win: entry.win, ok: true, destroyed: false, skipped: true, method: 'bottom', parentClass: '', detail: 'settled bottom fallback, unchanged. ' + entry.fallbackReason });
          continue;
        }
        const res = attach(entry.win, entry.rectDip, entry.opts);
        results.push({ win: entry.win, destroyed: false, ...res });
      } catch (e) {
        results.push({ win: entry.win, ok: false, destroyed: false, method: 'none', parentClass: '', detail: 'exception: ' + (e && e.message) });
      }
    }
    return results;
  }

  /** Poll for Explorer restarts. onReattach(results) is called when something had to be redone. */
  function startWatch(options = {}) {
    stopWatch();
    const interval = options.intervalMs || 2000;
    watchTimer = setInterval(() => {
      try {
        if (platform !== 'win32' || !getApi() || entries.size === 0) return;
        let redo = false;
        for (const entry of entries.values()) {
          if (needsReattach(entry)) redo = true;
          else repairInPlace(entry);
        }
        if (redo) {
          const results = reattachAll();
          if (typeof options.onReattach === 'function') options.onReattach(results);
        }
      } catch (e) {
        log('watch exception', e && e.message);
      }
    }, interval);
    if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref();
  }
  function stopWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  // ---- diagnostics ----------------------------------------------------------------------------
  function inspect() {
    if (platform !== 'win32' || !getApi()) return { supported: false, detail: loadError || 'not windows' };
    const s = takeSnapshot();
    return {
      supported: true,
      build: windowsBuild(osMod),
      layout: s.layout,
      raisedByExStyle: s.raisedByExStyle,
      progman: hex(s.progman),
      progmanExStyle: hex(s.progmanExStyle),
      progmanRect: s.progmanRect,
      refArea: s.refArea,
      progmanDefView: hex(s.progmanDefView),
      progmanWorkers: s.progmanWorkers.map((w) => ({ hwnd: hex(w.hwnd), area: w.area })),
      progmanWorkerLayer: hex(s.progmanWorkerLayer),
      classicHosts: s.classicHosts.map((c) => ({ host: hex(c.host), defView: hex(c.defView), workerW: hex(c.workerW), area: c.area })),
      classicWorkerW: hex(s.classicWorkerW),
      hasLayer: s.hasLayer,
      apiErrors: getApi().errors ? getApi().errors.slice(-10) : [],
    };
  }

  function describeNode(A, h, depth, maxDepth) {
    const r = A.getWindowRect(h);
    const parent = A.getParent(h);
    const node = {
      hwnd: hex(h),
      class: A.getClassName(h),
      rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
      visible: A.isWindowVisible(h),
      style: hex(A.getStyle(h)),
      exStyle: hex(A.getExStyle(h)),
      parent: hex(parent),
      parentClass: parent ? A.getClassName(parent) : '',
    };
    if (depth < maxDepth) node.children = childList(h).map((c) => describeNode(A, c, depth + 1, maxDepth));
    return node;
  }

  /** The window tree the shell uses for the desktop, as JSON-able data. */
  function dumpTree(extraWindows = []) {
    if (platform !== 'win32' || !getApi()) return { supported: false };
    const A = getApi();
    const interesting = new Set(['Progman', 'WorkerW']);
    const roots = [];
    for (const top of A.enumTopLevel()) {
      const cls = A.getClassName(top);
      if (interesting.has(cls) || A.findWindowEx(top, 0, 'SHELLDLL_DefView')) roots.push(top);
    }
    const extras = [];
    for (const w of extraWindows) {
      try {
        const h = readHwnd(w);
        if (h) extras.push(describeNode(A, h, 0, 1));
      } catch (_) {
        /* ignore */
      }
    }
    return {
      supported: true,
      build: windowsBuild(osMod),
      osRelease: String(osMod.release()),
      desktopWindow: hex(A.getDesktopWindow()),
      shell: roots.map((h) => describeNode(A, h, 0, 3)),
      ours: extras,
      attached: Array.from(entries.values()).map((e) => ({ hwnd: hex(e.hwnd), method: e.method, layout: e.layout, parent: hex(e.parentHwnd), phys: e.phys })),
    };
  }

  return {
    supported,
    attach,
    detach,
    describe,
    reattachAll,
    startWatch,
    stopWatch,
    inspect,
    dumpTree,
    setLogger(fn) {
      if (typeof fn === 'function') log = fn;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Default singleton plus the factory. Importing this module on macOS/Linux never loads koffi.
// ---------------------------------------------------------------------------------------------
const singleton = createWallpaper();
module.exports = Object.assign(singleton, {
  createWallpaper,
  createApi,
  _internals: { u32, setBits, classifyLayout, readHwnd, windowsBuild, PROTOTYPES, KERNEL32_PROTOTYPES, CALLBACK_PROTO, declareTypes, describeSetParentFailure },
});
