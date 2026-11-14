'use strict';
// B-Side for Windows: plays a YouTube video, playlist or mix as the desktop wallpaper on every
// screen, with sound from the main screen. This file only wires Electron to the logic in core/.
//
// Environment hooks (tests and development):
//   BSIDE_TEST=1    write status.json every tick, skip the first-run panel, no global shortcuts,
//                   no login item, never open the browser, no Dock icon on a Mac
//   BSIDE_MUTE=1    every player is muted at the audio level, whatever the settings say
//   BSIDE_SMALL=1   player windows are 640x360 in the screen corner instead of fullscreen
//   BSIDE_SHORTCUTS=1  register the global shortcuts even in test mode
//   BSIDE_CLIPBOARD=<text>  in test mode, the text "the clipboard" holds
//   --user-data-dir=<dir>   keep state, logs, cookies and the instance lock in that folder
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, session, ipcMain, globalShortcut, powerMonitor, clipboard, shell, net, nativeTheme } = electron;

const { parseArgv, normaliseCli, createRouter } = require('./core/commands');
const { parseUrl, watchUrl } = require('./core/url');
const { Store, DEFAULTS } = require('./core/state');
const { playerPage } = require('./core/player-page');
const { createFrameLoader, StillGuard } = require('./core/stills');
const { panelState, playerErrorText } = require('./core/status');
const { Saver } = require('./core/saver');
const { createShortcuts } = require('./core/shortcuts');
const { createLogger } = require('./core/logger');
const { writeAtomic } = require('./core/safe-write');
const { playerWindowOptions, panelBounds } = require('./core/window-options');
const { createPowerHandlers } = require('./core/power');
const { installShim, removeShim } = require('./core/cli-install');

const TEST = process.env.BSIDE_TEST === '1';
const SMALL = process.env.BSIDE_SMALL === '1';
const FORCE_MUTE = process.env.BSIDE_MUTE === '1';
const HOST = 'localhost.bside';
const PARTITION = 'persist:bside-player';
const PLAYER_UA_STRIP = /\s(Electron|B-Side|b-side-windows)\/\S+/g;

// ------------------------------------------------------------ process setup (before ready)

const args = parseArgv(process.argv);
app.setName('B-Side');
if (args.userDataDir) app.setPath('userData', path.resolve(args.userDataDir));
if (args.userDataDir || TEST) {
  try { app.setAppLogsPath(path.join(app.getPath('userData'), 'logs')); } catch (e) { /* keep the default */ }
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// A window parented into the desktop looks hidden to Chromium, which would pause the video.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const DATA_DIR = app.getPath('userData');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const log = createLogger(path.join(app.getPath('logs'), 'B-Side.log'));

// A background app should never die on a stray error. Log it and carry on.
process.on('uncaughtException', function (e) { log('uncaught exception: ' + (e && e.stack || e)); });
process.on('unhandledRejection', function (e) { log('unhandled rejection: ' + (e && e.stack || e)); });
// Wraps an event handler so one failure is logged instead of thrown.
function guard(label, fn) {
  return function () {
    try { return fn.apply(this, arguments); } catch (e) { log(label + ': ' + (e && e.stack || e)); }
  };
}

// ------------------------------------------------------------ wallpaper layer (lane B)

const STUB_WALLPAPER = {
  supported: function () { return false; },
  attach: function () { return { ok: false, method: 'none', parentClass: '', detail: 'wallpaper module not available' }; },
  detach: function () {},
  describe: function () { return { parentClass: '', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, isChild: false }; },
  reattachAll: function () { return []; },
  startWatch: function () {},
  stopWatch: function () {}
};
let wallpaper = STUB_WALLPAPER;
try {
  wallpaper = Object.assign({}, STUB_WALLPAPER, require('./win/wallpaper'));
  if (typeof wallpaper.setLogger === 'function') wallpaper.setLogger(function () { log('wallpaper ' + Array.prototype.join.call(arguments, ' ')); });
} catch (e) { log('wallpaper module: ' + e.message); }

// ------------------------------------------------------------ state

const store = new Store(DATA_DIR);
let settings = store.settings;
let on = false;              // wallpaper showing
let mode = 'wallpaper';      // 'wallpaper' | 'screensaver'
let current = null;          // link being played
let main = {};               // last status reported by the main player
let error = null, errorAt = 0, playerError = null;
let pausedBy = null;         // 'lock' | 'battery' | null
let tick = 0;
let quitting = false;
let reloadCount = 0;
let saverPoll = null;
let layout = '';
let wallInfo = { method: 'none', parentClass: '' };
let wins = [];               // [{ win, display }] screen 0 is the primary display and carries the sound
let panel = null, tray = null;
let shortcutsApi = null;
let sessionPlayer = null;

const saver = new Saver();
const stills = new StillGuard({
  loadFrames: null,          // set once electron is ready
  skip: function () { jsMain('player.nextVideo()'); },
  log: log
});

function setError(msg) { error = msg; errorAt = Date.now(); }

// ------------------------------------------------------------ player windows

function jsIn(w, code) {
  try { if (w && !w.win.isDestroyed()) w.win.webContents.executeJavaScript(code).catch(function () {}); } catch (e) { /* window going away */ }
}
function jsMain(code) { if (wins[0]) jsIn(wins[0], code); }
function jsAll(code) { wins.forEach(function (w) { jsIn(w, code); }); }

function wantedDisplays() {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays().slice().sort(function (a, b) {
    return (b.id === primary.id ? 1 : 0) - (a.id === primary.id ? 1 : 0);
  });
  return settings.screens === 'main' ? [primary] : all;
}

function layoutKey(ds) {
  return ds.map(function (d) { return [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height].join(','); }).join('|');
}

function playerRect(display) {
  if (!SMALL) return display.bounds;
  const wa = display.workArea;
  return { x: wa.x + wa.width - 640 - 16, y: wa.y + wa.height - 360 - 16, width: 640, height: 360 };
}

function wantTransparent() { return process.env.BSIDE_TRANSPARENT === '1' || !!settings.wallpaperTransparent; }

// Windows close a window with Alt+F4 or at shutdown. A player window must survive Alt+F4 (a screensaver
// with no way back would leave a blank screen), and nothing may block a shutdown, so a guard
// that ignores close only holds until the app is quitting or the session is ending.
function guardClose(win, onClose) {
  win.on('close', function (e) { if (!quitting) { e.preventDefault(); if (onClose) onClose(); } });
  win.on('session-end', function () { quitting = true; });
  win.on('query-session-end', function () { quitting = true; });
}

function playerUrl(i) { log('loading player ' + i); return 'https://' + HOST + '/player?f=' + (i > 0 ? 1 : 0) + '&r=' + (++reloadCount); }

function teardown() {
  // Silence the old players first, or they keep playing unseen.
  wins.forEach(function (w) {
    try { wallpaper.detach(w.win); } catch (e) { /* ignore */ }
    try { if (!w.win.isDestroyed()) { w.win.webContents.setAudioMuted(true); w.win.destroy(); } } catch (e) { /* ignore */ }
  });
  wins = []; layout = '';
}

// One borderless window per screen. Screen 0 is the primary display and carries the sound.
function build(force) {
  if (!on) return;
  const ds = wantedDisplays();
  if (!ds.length) return;   // no display at the moment (a remote session, say): keep what we have
  const now = layoutKey(ds);
  if (!force && now === layout) return;
  teardown();
  layout = now;
  ds.forEach(function (display, i) {
    const win = new BrowserWindow(playerWindowOptions({
      rect: playerRect(display), session: sessionPlayer, preload: path.join(__dirname, 'preload.js'), transparent: wantTransparent()
    }));
    const wc = win.webContents;
    if (i > 0 || FORCE_MUTE) wc.setAudioMuted(true);
    wc.on('will-navigate', guard('will-navigate', function (e, url) { if (new URL(url).hostname !== HOST) e.preventDefault(); }));
    wc.setWindowOpenHandler(function () { return { action: 'deny' }; });
    wc.on('before-input-event', guard('input', function (e, input) {
      if (mode !== 'screensaver') return;
      if (input.type === 'keyDown') saverInput('key', 0);
      else if (input.type === 'mouseDown') saverInput('click', 0);
    }));
    guardClose(win);   // teardown() uses destroy(), which skips this
    win.on('closed', function () { wins = wins.filter(function (w) { return w.win !== win; }); });
    wins.push({ win: win, display: display, id: wc.id });
    win.loadURL(playerUrl(i)).catch(function (e) { log('player load: ' + e.message); });
  });
  applyMode();
}

// The displays changed. Same number of screens: move the windows in place (a rebuild would restart
// the video). Otherwise rebuild. Returns true when the layout really changed.
function relayout() {
  if (!on) return false;
  const ds = wantedDisplays();
  if (!ds.length) return false;
  const now = layoutKey(ds);
  if (now === layout) return false;
  log('screens changed: ' + now);
  if (ds.length !== wins.length) { build(true); return true; }
  layout = now;
  ds.forEach(function (d, i) { wins[i].display = d; });
  applyMode(true);   // sizes the saver windows, or attaches the wallpaper windows again with the new rectangle
  return true;
}

// Once a window is attached to the desktop, never call setBounds or show on it (lane B's rule).
// A new rectangle goes through attach() again.
function attachWallpaper(w, i) {
  const rect = playerRect(w.display);
  let res;
  try { res = wallpaper.attach(w.win, rect, { clickThrough: true }); }
  catch (e) { res = { ok: false, method: 'none', parentClass: '', detail: String(e) }; }
  w.attached = !!res.ok;
  log('wallpaper attach screen ' + i + ': ' + res.method + (res.parentClass ? ' in ' + res.parentClass : '') + (res.ok ? '' : ' (not attached) ' + (res.detail || '')));
  if (i === 0) wallInfo = { method: res.method, parentClass: res.parentClass || '' };
  return res;
}

// While the screensaver runs, ask Windows how long since any input. Input in a window that never
// sees it (another monitor, a game controller) still counts.
function startSaverPoll() {
  stopSaverPoll();
  saverPoll = setInterval(guard('saver poll', function () {
    if (mode !== 'screensaver') { stopSaverPoll(); return; }
    saverInput('idle', powerMonitor.getSystemIdleTime());
  }), 250);
}
function stopSaverPoll() { if (saverPoll) clearInterval(saverPoll); saverPoll = null; }

function applyMode(keepSaverClock) {
  const saverOn = mode === 'screensaver';
  wins.forEach(function (w, i) {
    const win = w.win;
    if (win.isDestroyed()) return;
    const rect = playerRect(w.display);
    if (saverOn) {
      if (w.attached) { try { wallpaper.detach(win); } catch (e) { log('detach: ' + e.message); } w.attached = false; }
      win.setIgnoreMouseEvents(false);
      win.setFocusable(true);
      win.setBounds(rect);
      win.setBounds(rect);   // twice: the first can land on the old display's scale
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'win32' && !SMALL) win.setFullScreen(true);
      if (TEST) win.showInactive(); else { win.show(); if (i === 0) win.focus(); }
    } else if (w.attached) {
      attachWallpaper(w, i);   // already in the desktop: only re-attach, never touch the window
    } else {
      let done = false;
      const toWallpaper = function () {
        if (done || win.isDestroyed()) return;
        done = true;
        win.setAlwaysOnTop(false);
        win.setFocusable(false);
        if (wallpaper.supported()) {
          // Show it once while it is still a normal window, then attach, which sizes it and makes it click-through.
          win.showInactive();
          attachWallpaper(w, i);
        } else {
          win.setIgnoreMouseEvents(true);
          win.setBounds(rect);
          win.showInactive();
        }
      };
      if (win.isFullScreen()) {
        win.once('leave-full-screen', toWallpaper);
        setTimeout(toWallpaper, 500);   // the event can be lost, and a window stuck fullscreen would never attach
        win.setFullScreen(false);
      } else toWallpaper();
    }
  });
  if (saverOn) {
    if (!keepSaverClock) { saver.enter(); startSaverPoll(); }
    if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide();
  } else stopSaverPoll();
}

// After a display change or an Explorer restart: windows whose native handle died get rebuilt.
function afterReattach(results) {
  results = results || [];
  if (results.some(function (r) { return r && r.destroyed; })) { log('wallpaper window destroyed, rebuilding'); build(true); return; }
  const first = results.find(function (r) { return r && r.ok; });
  if (first) wallInfo = { method: first.method, parentClass: first.parentClass || '' };
}

function setMode(m) {
  if (m !== 'wallpaper' && m !== 'screensaver') return;
  if (m === mode) return;
  log('mode ' + m);
  mode = m;
  if (on) applyMode();
}

function saverInput(kind, px) {
  if (mode !== 'screensaver') return;
  const why = kind === 'idle' ? saver.idle(px) : saver.input(kind, px);
  if (why) { log('screensaver ended by ' + why); setMode('wallpaper'); pushPanel(); }
}

// ------------------------------------------------------------ playback

function start(url, m) {
  const p = parseUrl(url || '');
  if (!p.id && !p.list) { setError('That link is not a YouTube video or playlist.'); return; }
  setError(null);
  current = url;
  main = {};
  playerError = null;
  pausedBy = null;
  stills.reset();
  if (m) mode = m;
  if (!on) { on = true; build(true); }
  else {
    // Same screens, new video: reload in place.
    wins.forEach(function (w, i) { if (!w.win.isDestroyed()) w.win.loadURL(playerUrl(i)).catch(function () {}); });
    applyMode();
  }
  store.last = { url: url };
  store.save();
}

function stop() {
  if (main.id) store.last = { url: watchUrl(main.id, parseUrl(current || '').list, main.t, main.i) };
  store.save();
  on = false; mode = 'wallpaper'; main = {}; pausedBy = null;
  teardown();
}

function readMain() {
  try {
    const w = wins[0];
    if (!w || w.win.isDestroyed()) return;
    const st = JSON.parse(w.win.webContents.getTitle());
    if (st && st.id) {
      main = st;
      if (st.title && store.rememberRecent(st.id, parseUrl(current || '').list, st.title)) store.save();
      playerError = playerErrorText(st.err)
        || (stills.mixIsStill(st.id) ? 'This mix is mostly audio uploads with a still picture. Start it from an official music video for moving pictures.' : null);
    }
  } catch (e) { /* the title is not a report yet */ }
}

// Keep the other screens on the main screen's video, second and play state.
function syncFollowers() {
  if (wins.length < 2 || !main.id) return;
  const code = 'follow(' + JSON.stringify(main.id) + ',' + (main.t || 0) + ',' + (main.s === undefined ? -1 : main.s) + ')';
  for (let i = 1; i < wins.length; i++) jsIn(wins[i], code);
}

function readClipboard() {
  if (TEST && process.env.BSIDE_CLIPBOARD !== undefined) return process.env.BSIDE_CLIPBOARD;
  try { return clipboard.readText() || ''; } catch (e) { return ''; }
}

function playClipboard(m) {
  const clip = readClipboard().trim();
  if (/youtu\.?be/.test(clip)) start(clip, m || mode); else setError('The clipboard has no YouTube link.');
}

// Stop the wallpaper and carry on in the default browser from the same second.
function backToBrowser() {
  readMain();
  const p = parseUrl(current || '');
  const url = main.id ? watchUrl(main.id, p.list, main.t, main.i) : current;
  stop();
  if (!url) return;
  log('open in browser ' + url);
  if (!TEST) shell.openExternal(url).catch(function (e) { log('openExternal: ' + e.message); });
}

// ------------------------------------------------------------ settings with side effects

function setSetting(key, value) {
  if (store.set(key, value) === undefined) return;
  if (key === 'volume') { settings.muted = false; jsMain('setVol(' + settings.volume + ')'); }
  if (key === 'muted') jsMain('setMuted(' + settings.muted + ')');
  if (key === 'dim' || key === 'fill') jsAll('setLook(' + settings.dim + ',' + settings.fill + ')');
  if (key === 'screens') build(true);
  if (key === 'wallpaperTransparent' && on) build(true);
  if (key === 'cli') applyCli();
  if (key === 'skipStill') stills.reset();
  if (key === 'launchAtLogin') applyLogin();
  if (key === 'shortcuts') { if (settings.shortcuts) setupShortcuts(); else if (shortcutsApi) shortcutsApi.disable(); }
  store.save();
}

// The `bside` command: a copy of bin/bside.cmd in a folder that is already on the PATH.
function cliDir() { return path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Microsoft', 'WindowsApps'); }
function applyCli() {
  if (process.platform !== 'win32' || !app.isPackaged || TEST) { log('cli ' + (settings.cli ? 'on' : 'off') + ' (not applied, app is not installed on Windows)'); return; }
  const src = [path.join(process.resourcesPath || '', 'bside.cmd'), path.join(__dirname, '..', 'bin', 'bside.cmd')].find(function (f) { try { return fs.existsSync(f); } catch (e) { return false; } });
  const res = settings.cli
    ? (src ? installShim({ src: src, destDir: cliDir(), exePath: process.execPath }) : { ok: false, action: 'failed', detail: 'bside.cmd not found in the app' })
    : removeShim({ destDir: cliDir() });
  log('cli ' + res.action + (res.detail ? ': ' + res.detail : ''));
}

function applyLogin() {
  if (!app.isPackaged || TEST) { log('launch at login ' + (settings.launchAtLogin ? 'on' : 'off') + ' (not applied, app is not installed)'); return; }
  try { app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin }); } catch (e) { log('login item: ' + e.message); }
}

// ------------------------------------------------------------ shortcuts

function setupShortcuts() {
  if (!settings.shortcuts) return;
  if (TEST && process.env.BSIDE_SHORTCUTS !== '1') { log('shortcuts: skipped in test mode'); return; }
  if (!shortcutsApi) shortcutsApi = createShortcuts(globalShortcut, function (name) { hotkey(name); }, log);
  shortcutsApi.enable();
}

function hotkey(name) {
  log('shortcut ' + name);
  switch (name) {
    case 'browser': case 'chrome': {
      // Play the link on the clipboard, or send the wallpaper back to the browser, or show the panel.
      const clip = readClipboard().trim();
      const cp = parseUrl(clip);
      if (/youtu\.?be/.test(clip) && (cp.id || cp.list)) start(clip, mode);
      else if (on) backToBrowser();
      else showPanel();
      break;
    }
    case 'play': if (on) command('toggle'); break;
    case 'next': if (on) command('next'); break;
    case 'prev': if (on) command('prev'); break;
    case 'saver': if (on) setMode(mode === 'screensaver' ? 'wallpaper' : 'screensaver'); break;
    case 'mute': command('mute'); break;
  }
  pushPanel();
}

// ------------------------------------------------------------ control panel

function makeTrayIcon() {
  const files = [path.join(__dirname, '..', 'build', 'icon.ico'), path.join(process.resourcesPath || '', 'icon.ico')];
  for (const f of files) {
    try { if (fs.existsSync(f)) { const img = nativeImage.createFromPath(f); if (!img.isEmpty()) return img; } } catch (e) { /* try the next */ }
  }
  // No icon file yet: draw a small pink disc with a note on it (BGRA, 32 px, shown at 16 dip).
  const size = 32, buf = Buffer.alloc(size * size * 4), c = (size - 1) / 2;
  function put(x, y, r, g, b, a) { const i = (y * size + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c);
    const a = Math.max(0, Math.min(1, 15.5 - d));
    if (a > 0) put(x, y, 255, 59, 92, Math.round(a * 255));
  }
  for (let y = 8; y <= 21; y++) for (let x = 18; x <= 20; x++) put(x, y, 255, 255, 255, 255);          // stem
  for (let y = 18; y <= 26; y++) for (let x = 9; x <= 19; x++) { if (Math.hypot(x - 14, (y - 22) * 1.2) <= 4.6) put(x, y, 255, 255, 255, 255); }   // head
  for (let k = 0; k < 6; k++) for (let x = 21 + k; x <= 23 + k && x < size; x++) put(x, 8 + k * 2, 255, 255, 255, 255);   // flag
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function makePanel() {
  let wa = null;
  try { const d = screen.getPrimaryDisplay(); wa = d && d.workArea; } catch (e) { /* no display */ }
  const b = panelBounds(wa);
  try {
    panel = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, useContentSize: true,
      title: 'B-Side', show: false, backgroundColor: '#1c1c1e', autoHideMenuBar: true, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    panel.setMenuBarVisibility(false);
    panel.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
    panel.webContents.on('will-navigate', guard('will-navigate', function (e) { e.preventDefault(); }));
    guardClose(panel, function () { panel.hide(); });   // the close button hides it, but never blocks a shutdown
    panel.loadFile(path.join(__dirname, 'panel.html'));
  } catch (e) {
    log('panel: ' + (e && e.stack || e));
    try { if (panel && !panel.isDestroyed()) panel.destroy(); } catch (e2) { /* ignore */ }
    panel = null;
  }
}

function showPanel() {
  if (!panel || panel.isDestroyed()) makePanel();
  if (!panel) return;
  if (mode === 'screensaver') setMode('wallpaper');
  if (panel.isMinimized()) panel.restore();
  if (TEST) panel.showInactive(); else { panel.show(); panel.focus(); }
  pushPanel();
}

function hidePanel() { if (panel && panel.isVisible()) panel.hide(); }

function togglePanel() { if (panel && panel.isVisible()) hidePanel(); else showPanel(); }

function wallpaperStatus() {
  const w = wins[0];
  if (w && w.attached && !w.win.isDestroyed()) {
    try {
      const d = wallpaper.describe(w.win);
      return { method: d.method || wallInfo.method, parentClass: d.parentClass || wallInfo.parentClass };
    } catch (e) { /* fall through */ }
  }
  return wallInfo;
}

function currentState() {
  return panelState({
    now: Date.now(), on: on, mode: mode, error: error, errorAt: errorAt, playerError: playerError, pausedBy: pausedBy,
    screens: screen.getAllDisplays().length, current: current, main: main,
    settings: settings, recents: store.recents, last: store.last, version: app.getVersion(),
    players: wins.length,
    followers: wins.slice(1).map(function (w) {
      try { return JSON.parse(w.win.webContents.getTitle()).id || null; } catch (e) { return null; }
    }),
    panelOpen: !!(panel && !panel.isDestroyed() && panel.isVisible()),
    shortcuts: shortcutsApi ? shortcutsApi.info(settings.shortcuts) : { enabled: !!settings.shortcuts, registered: [], failed: [] },
    wallpaper: wallpaperStatus(), platform: process.platform
  });
}

function pushPanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  try { panel.webContents.send('bside:render', currentState()); } catch (e) { /* page still loading */ }
}

function writeStatus() {
  try { writeAtomic(STATUS_FILE, JSON.stringify(currentState(), null, 1)); }
  catch (e) { log('status: ' + e.message); }
}

function updateTray() {
  if (!tray) return;
  const paused = main.s !== 1;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show panel', click: function () { showPanel(); } },
    { label: on && !paused ? 'Pause' : 'Play', enabled: on, click: function () { command('toggle'); } },
    { type: 'separator' },
    { label: 'Wallpaper', type: 'radio', checked: mode === 'wallpaper', click: function () { command('wallpaper'); } },
    { label: 'Screensaver', type: 'radio', checked: mode === 'screensaver', click: function () { command('screensaver'); } },
    { type: 'separator' },
    { label: 'Quit B-Side', click: function () { command('quit'); } }
  ]));
}

// ------------------------------------------------------------ the engine the command router drives

const engine = {
  settings: function () { return settings; },
  isOn: function () { return on; },
  mode: function () { return mode; },
  canResume: function () { return !!store.last; },
  lastUrl: function () { return store.last && store.last.url; },
  toggle: function () { jsMain('toggle()'); },
  play: function () { jsMain('player.playVideo()'); },
  next: function () { jsMain('player.nextVideo()'); },
  prev: function () { jsMain('player.previousVideo()'); },
  seek: function (n) { if (isFinite(n)) jsMain('player.seekTo(' + Number(n) + ',true)'); },
  setSetting: setSetting,
  setMode: setMode,
  start: start,
  playClipboard: playClipboard,
  recent: function (i) { const r = store.recents[i]; if (r) start(watchUrl(r.id, r.list, 0, -1), mode); },
  forget: function () { store.forgetRecents(); store.save(); },
  backToBrowser: backToBrowser,
  stop: stop,
  showPanel: showPanel,
  hidePanel: hidePanel,
  hotkey: hotkey,
  writeStatus: writeStatus,
  quit: function () { quitting = true; stop(); app.quit(); },
  setError: setError,
  pushPanel: function () { pushPanel(); updateTray(); }
};
const command = createRouter(engine, log);

// Test-only: `shot:<file.png>` saves the panel or, with `shot:player:<file.png>`, the main player window.
function handleCommand(raw) {
  raw = String(raw);
  if (TEST && raw.startsWith('shot:')) {
    const rest = raw.slice(5), player = rest.startsWith('player:');
    const file = player ? rest.slice(7) : rest;
    const target = player ? (wins[0] && wins[0].win) : panel;
    if (target && !target.isDestroyed()) {
      target.webContents.capturePage().then(function (img) { fs.writeFileSync(file, img.toPNG()); log('shot ' + file); }).catch(function (e) { log('shot: ' + e.message); });
    }
    return;
  }
  command(raw);
}

// ------------------------------------------------------------ timers and power

function onTick() {
  try {
    tick++;
    if (on) {
      readMain();
      syncFollowers();
      stills.tick(main, !!parseUrl(current || '').list, settings);
    }
    if (on && tick % 5 === 0 && settings.idleSaver > 0 && mode === 'wallpaper' && powerMonitor.getSystemIdleTime() >= settings.idleSaver * 60) setMode('screensaver');
    if (on && tick % 30 === 0 && (settings.pauseOnBattery || pausedBy === 'battery')) smartPause('battery', powerMonitor.isOnBatteryPower());
    if (settings.shortcuts && shortcutsApi && tick % 30 === 0) shortcutsApi.retryFailed();
    if (on && tick % 10 === 0 && main.id) { store.last = { url: watchUrl(main.id, parseUrl(current).list, main.t, main.i) }; store.save(); }
    if (TEST) writeStatus();
    pushPanel();
  } catch (e) { log('tick: ' + e); }
}

function smartPause(reason, pause) {
  if (!on) return;
  if (pause) {
    if (reason === 'lock' && !settings.pauseOnLock) return;
    if (reason === 'battery' && !settings.pauseOnBattery) return;
    if (main.s === 1 && !pausedBy) { pausedBy = reason; jsMain('player.pauseVideo()'); }
  } else if (pausedBy === reason) {
    pausedBy = null; jsMain('player.playVideo()');
  }
  pushPanel();
}

// ------------------------------------------------------------ startup

// Handing a request to the network from the protocol handler drops its Referer, which the
// YouTube embed needs (error 153 without it). Put it back from the request's referrer.
function passThroughInit(req) {
  const init = { bypassCustomProtocolHandlers: true };
  if (req.referrer && /^https?:/i.test(req.referrer)) {
    const h = new Headers(req.headers);
    h.set('referer', req.referrer);
    init.headers = h;
  }
  return init;
}

function setupPlayerSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(PLAYER_UA_STRIP, ''));
  ses.setPermissionRequestHandler(function (wc, perm, cb) { cb(false); });
  // The player page is served from https://localhost.bside/, so the YouTube embed sees a real
  // https origin and Referer (without one it refuses with error 153). Everything else goes
  // straight through to the network.
  ses.protocol.handle('https', function (req) {
    let u;
    try { u = new URL(req.url); } catch (e) { return ses.fetch(req, passThroughInit(req)); }
    if (u.hostname === HOST) {
      if (u.pathname === '/player') {
        const html = playerPage(current, u.searchParams.get('f') === '1', settings, { forceMute: FORCE_MUTE, transparent: wantTransparent() });
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return new Response('', { status: 404 });
    }
    if (process.env.BSIDE_DEBUG_NET === '1' && /youtube\.com\/embed/.test(req.url)) {
      const h = {}; req.headers.forEach(function (v, k) { h[k] = v; });
      log('net ' + req.method + ' ' + req.url.slice(0, 90) + ' referrer=' + req.referrer + ' headers=' + JSON.stringify(h));
    }
    return ses.fetch(req, passThroughInit(req));
  });
  return ses;
}

function listen() {
  ipcMain.on('bside:cmd', guard('ipc cmd', function (e, cmd) { if (panel && !panel.isDestroyed() && e.sender === panel.webContents) handleCommand(cmd); }));
  ipcMain.on('bside:ready', guard('ipc ready', function (e) { if (panel && !panel.isDestroyed() && e.sender === panel.webContents) pushPanel(); }));
  ipcMain.on('bside:input', guard('ipc input', function (e, kind, px) {
    if (wins.some(function (w) { return !w.win.isDestroyed() && w.win.webContents === e.sender; })) saverInput(kind, px);
  }));

  const rebuild = (function () {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(guard('display change', function () { relayout(); }), 400); };
  })();
  screen.on('display-added', rebuild);
  screen.on('display-removed', rebuild);
  screen.on('display-metrics-changed', rebuild);

  const pw = createPowerHandlers(smartPause);
  powerMonitor.on('lock-screen', guard('lock-screen', pw.onLock));
  powerMonitor.on('unlock-screen', guard('unlock-screen', pw.onUnlock));
  powerMonitor.on('suspend', guard('suspend', pw.onSuspend));
  powerMonitor.on('resume', guard('resume', pw.onResume));
  powerMonitor.on('on-battery', guard('on-battery', pw.onBattery));
  powerMonitor.on('on-ac', guard('on-ac', pw.onAc));
}

// No other copy is running, so `status` and `quit` have nothing to talk to. Answer them
// before any window, tray icon or shortcut exists.
function answerWithoutApp(cmd) {
  if (cmd === 'status') {
    try { writeAtomic(STATUS_FILE, JSON.stringify({ running: false })); } catch (e) { /* ignore */ }
  } else if (cmd !== 'quit') return false;
  app.exit(0);
  return true;
}

function startApp() {
  if (answerWithoutApp(args.cmd)) return;
  if (process.platform === 'darwin' && TEST && app.dock) app.dock.hide();
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  store.load();
  settings = store.settings;
  log('start ' + app.getVersion() + ' on ' + process.platform + (TEST ? ' (test)' : '') + (SMALL ? ' (small windows)' : ''));

  sessionPlayer = setupPlayerSession();
  stills.deps.loadFrames = createFrameLoader(net, nativeImage);
  listen();

  tray = new Tray(makeTrayIcon());
  tray.setToolTip('B-Side');
  tray.on('click', guard('tray click', function () { togglePanel(); }));
  updateTray();

  setupShortcuts();
  applyCli();
  if (wallpaper.supported()) wallpaper.startWatch({ intervalMs: 2000, onReattach: afterReattach });
  setInterval(onTick, 1000);

  const first = args.cmd;

  if (settings.resumeOnLaunch && store.last) { log('resume on launch'); start(store.last.url, 'wallpaper'); }
  else if (!TEST && first === null) showPanel();
  if (first !== null && first !== '') handleCommand(normaliseCli(first));
  else if (first === '') showPanel();
  if (TEST) writeStatus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another copy is running. It gets this launch's command through the second-instance event.
  app.quit();
} else {
  app.on('second-instance', guard('second-instance', function (e, argv) {
    const a = parseArgv(argv);
    log('second launch, command ' + (a.cmd === null ? 'panel' : JSON.stringify(a.cmd)));
    handleCommand(a.cmd === null ? 'panel' : normaliseCli(a.cmd));
  }));
  app.on('window-all-closed', function () { /* the tray keeps the app alive */ });
  app.on('before-quit', function () { quitting = true; try { store.save(); } catch (e) { /* ignore */ } });
  app.on('will-quit', function () { try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });
  app.whenReady().then(startApp).catch(function (e) { log('startup failed: ' + (e && e.stack || e)); });
}

module.exports = { DEFAULTS };
