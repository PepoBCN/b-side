'use strict';
// Shared helpers for the end-to-end tests.
//
// The same spec runs two ways:
//   Windows CI    BSIDE_EXE=<path to the installed B-Side.exe>  (the packaged app)
//   Mac or dev    nothing set, runs `electron .` from windows/ with BSIDE_TEST, BSIDE_MUTE and BSIDE_SMALL
//
// State is read through `B-Side.exe --cmd status`: a second process hands the command to the
// running copy (the single-instance lock) and the copy writes status.json in its user data folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { _electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');           // windows/
const IS_WIN = process.platform === 'win32';
const EXE = process.env.BSIDE_EXE ? path.resolve(process.env.BSIDE_EXE) : null;
const ARTIFACTS = path.resolve(process.env.E2E_ARTIFACTS || path.join(ROOT, 'dist', 'e2e-artifacts'));

// A long official video (loops on its own) and an official playlist. Both are Blender Foundation uploads.
const VIDEO = process.env.BSIDE_E2E_VIDEO || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const PLAYLIST = process.env.BSIDE_E2E_PLAYLIST || 'https://www.youtube.com/watch?v=dhzPnX07jAs&list=PL0BAFA2DA294B0900';

// Player error codes that mean "YouTube refused this client", not "the app is broken".
const BLOCK_CODES = [101, 150, 152];   // 153 (player configuration error, missing Referer) is deliberately not here: it is an app fault
const BLOCK_TEXT = /confirm you.?re not a bot|sign in to confirm|unusual traffic|video unavailable|this video is not available/i;

fs.mkdirSync(ARTIFACTS, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeout = 15000, interval = 250, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last, lastErr;
  for (;;) {
    try { last = await fn(); if (last) return last; lastErr = null; } catch (e) { lastErr = e; if (e && e.fatal) throw e; }
    if (Date.now() > end) {
      throw new Error('Timed out after ' + timeout + ' ms waiting for ' + message + (lastErr ? ' (last error: ' + lastErr.message + ')' : ''));
    }
    await sleep(interval);
  }
}

function artifactPath(name) { return path.join(ARTIFACTS, name); }
function writeJson(name, obj) { fs.writeFileSync(artifactPath(name), JSON.stringify(obj, null, 2)); }
function mergeJson(name, patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(artifactPath(name), 'utf8')); } catch (e) { /* first write */ }
  writeJson(name, Object.assign(cur, patch));
}

// ------------------------------------------------------------ launching

function baseEnv(extra) {
  // Windows runs real size (the wallpaper must cover the display). Anywhere else the windows stay small.
  const small = process.env.E2E_SMALL !== undefined ? process.env.E2E_SMALL : (IS_WIN ? '0' : '1');
  return Object.assign({}, process.env, {
    BSIDE_TEST: '1',
    BSIDE_MUTE: process.env.E2E_UNMUTED === '1' ? '0' : '1',
    BSIDE_SMALL: small,
    ELECTRON_ENABLE_LOGGING: '1'
  }, extra || {});
}

function command() {
  if (EXE) return { file: EXE, lead: [] };
  return { file: require('electron'), lead: [ROOT] };   // require('electron') is the path to the binary
}

function newUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bside-e2e-'));
}

async function launchApp(opts) {
  opts = opts || {};
  // defaultUserData: start the app the way a user does, with no --user-data-dir, so the bside.cmd shim (which cannot pass one) finds it.
  const userDataDir = opts.defaultUserData ? path.join(process.env.APPDATA || os.homedir(), 'B-Side') : (opts.userDataDir || newUserDataDir());
  const c = command();
  const app = await _electron.launch({
    executablePath: c.file,
    args: c.lead.concat(opts.defaultUserData ? [] : ['--user-data-dir=' + userDataDir]),
    env: baseEnv(opts.env),
    timeout: 60000
  });
  return { app, userDataDir, pid: app.process().pid, exe: c.file };
}

// Runs the app a second time with --cmd. Resolves with the exit code and how long it took.
function runCmd(userDataDir, cmd, timeout) {
  timeout = timeout || 45000;
  const c = command();
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(c.file, c.lead.concat(['--cmd=' + cmd, '--user-data-dir=' + userDataDir]), {
      env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* already gone */ } }, timeout);   // only the PID we started
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ms: Date.now() - started, out, pid: child.pid }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, ms: Date.now() - started, out: String(e), pid: child.pid }); });
  });
}

function statusFile(dir) { return path.join(dir, 'status.json'); }
function logFile(dir) { return path.join(dir, 'logs', 'B-Side.log'); }

function readStatusFile(dir) {
  try { return JSON.parse(fs.readFileSync(statusFile(dir), 'utf8')); } catch (e) { return null; }
}

// Cheap read. In test mode the app rewrites status.json every second.
async function status(dir) {
  const s = readStatusFile(dir);
  if (s && s.running === false) return null;
  return s;
}

// The real thing: ask the running copy through a second process, then read what it wrote.
async function statusViaCmd(dir) {
  const before = Date.now();
  const r = await runCmd(dir, 'status');
  if (r.code !== 0) throw new Error('`--cmd status` exited with ' + r.code + ' ' + (r.signal || '') + '\n' + r.out);
  const s = await waitFor(() => {
    const st = fs.statSync(statusFile(dir));
    if (st.mtimeMs < before - 50) return null;
    const j = readStatusFile(dir);
    return j && j.platform ? j : null;
  }, { timeout: 15000, message: 'a fresh status.json after --cmd status' });
  return s;
}

function logText(dir) { try { return fs.readFileSync(logFile(dir), 'utf8'); } catch (e) { return ''; } }

// ------------------------------------------------------------ pages and YouTube diagnosis

function playerPages(app, follower) {
  return app.windows().filter((p) => {
    const u = p.url();
    if (!u.includes('localhost.bside/player')) return false;
    return follower === undefined ? true : (u.includes('f=1') === !!follower);
  });
}

async function mainPlayer(app) {
  return waitFor(() => playerPages(app, false)[0] || null, { timeout: 30000, message: 'the main player window' });
}

async function playerSnapshot(page) {
  return page.evaluate(() => {
    try {
      const d = player.getVideoData();
      let rep = null;
      try { rep = JSON.parse(document.title); } catch (e) { /* not a report yet */ }
      return { ready: true, s: player.getPlayerState(), t: player.getCurrentTime(), d: player.getDuration(), id: d.video_id,
               title: d.title, muted: player.isMuted(), v: player.getVolume(), err: rep ? rep.err : null, idx: player.getPlaylistIndex() };
    } catch (e) { return { ready: false, error: String(e) }; }
  });
}

async function youtubeDiagnosis(app) {
  const out = { pages: [], frames: [] };
  for (const p of playerPages(app)) {
    let title = '';
    try { title = await p.title(); } catch (e) { title = '(unreadable)'; }
    out.pages.push({ url: p.url(), title });
    for (const f of p.frames()) {
      if (f === p.mainFrame()) continue;
      let text = '';
      try { text = await f.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)); } catch (e) { text = '(unreadable: ' + e.message + ')'; }
      out.frames.push({ url: f.url(), text });
    }
  }
  return out;
}

function classifyBlock(snapshot, diag, st) {
  const code = snapshot && snapshot.err;
  if (BLOCK_CODES.includes(Number(code))) return { blocked: true, code: Number(code), reason: 'player error ' + code };
  const text = [].concat((diag && diag.frames || []).map((f) => f.text), st && st.error ? [st.error] : []).join(' | ');
  if (BLOCK_TEXT.test(text)) return { blocked: true, code: code || null, reason: text.slice(0, 200) };
  return { blocked: false, code: code || null, reason: '' };
}

class YouTubeBlocked extends Error {
  constructor(info, diag) {
    super('blocked-by-youtube: ' + info.reason + ' (player error code ' + info.code + '). YouTube refused this client; ' +
      'on a hosted runner that is a datacentre IP block, not an app bug. Details: ' + JSON.stringify(diag).slice(0, 600));
    this.fatal = true;
    this.blocked = info;
  }
}

// Waits until the main player reports state 1 (playing) with a moving clock.
// Fails fast with the player error code when YouTube refuses to play.
async function waitForPlaying(app, dir, { timeout = 120000 } = {}) {
  const page = await mainPlayer(app);
  const end = Date.now() + timeout;
  let snap = null, diag = null, st = null;
  while (Date.now() < end) {
    snap = await playerSnapshot(page);
    st = readStatusFile(dir);
    if (snap.ready && snap.err) {
      diag = await youtubeDiagnosis(app);
      const b = classifyBlock(snap, diag, st);
      if (b.blocked) { mergeJson('youtube-status.json', { 'blocked-by-youtube': true, code: b.code, reason: b.reason, diag, at: new Date().toISOString() }); throw new YouTubeBlocked(b, diag); }
    }
    if (snap.ready && snap.s === 1 && snap.t > 0) return { page, snap };
    await sleep(500);
  }
  diag = await youtubeDiagnosis(app);
  const b = classifyBlock(snap, diag, st);
  const detail = 'last player snapshot ' + JSON.stringify(snap) + '; status.error=' + JSON.stringify(st && st.error) + '; diagnosis ' + JSON.stringify(diag).slice(0, 800);
  if (b.blocked) { mergeJson('youtube-status.json', { 'blocked-by-youtube': true, code: b.code, reason: b.reason, diag, at: new Date().toISOString() }); throw new YouTubeBlocked(b, diag); }
  throw new Error('Video never started playing within ' + timeout + ' ms and nothing says YouTube blocked it, so treat this as an app bug. ' + detail);
}

// ------------------------------------------------------------ the desktop

function desktopShot(name) {
  const file = artifactPath(name + '.png');
  try {
    if (IS_WIN) {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'screenshot.ps1'), '-Path', file], { timeout: 60000 });
    } else if (process.env.E2E_DESKTOP_SHOT === '1' && process.platform === 'darwin') {
      execFileSync('screencapture', ['-x', file], { timeout: 30000 });
    } else return null;
    return fs.existsSync(file) ? file : null;
  } catch (e) {
    fs.writeFileSync(artifactPath(name + '.error.txt'), String(e && e.stack || e));
    return null;
  }
}

async function nativeHandle(app, which) {
  return app.evaluate(({ BrowserWindow }, f) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('localhost.bside/player?f=' + f));
    if (!w) return null;
    const b = w.getNativeWindowHandle();
    return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString();
  }, which ? 1 : 0);
}

// wallpaper.describe() from inside the running app (same module instance the app uses). Null if it cannot be reached.
async function describeWallpaper(app) {
  try {
    return await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('localhost.bside/player?f=0'));
      if (!w) return { error: 'no main player window' };
      const mod = process.mainModule.require('./win/wallpaper');
      return mod.describe(w);
    });
  } catch (e) { return { error: String(e && e.message || e) }; }
}

function probeWindow(hwnd) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'probe-window.ps1'), '-Hwnd', String(hwnd)], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error('probe-window.ps1 failed: ' + r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

async function closeApp(handle) {
  if (!handle) return;
  const pid = handle.pid;
  try { await Promise.race([handle.app.close(), sleep(15000)]); } catch (e) { /* already closing */ }
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
  for (let i = 0; i < 20 && alive(); i++) await sleep(250);
  if (alive()) { try { process.kill(pid); } catch (e) { /* gone */ } }   // only the PID Playwright started
}

// Main-process IDs of the copies of the app that use this user data folder (Chromium helpers carry --type=).
function mainProcessIds(dir) {
  const needle = '--user-data-dir=' + dir;
  let lines;
  if (IS_WIN) {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + needle.replace(/'/g, "''") + "') -and -not $_.CommandLine.Contains('--type=') } | ForEach-Object { $_.ProcessId }";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 60000 });
    lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ pid: Number(l) }));
  } else {
    const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    lines = (r.stdout || '').split('\n').filter((l) => l.includes(needle) && !l.includes('--type=')).map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]) }));
  }
  return lines.map((l) => l.pid).filter((n) => n > 0);
}

function copyEvidence(dir, label) {
  try { fs.copyFileSync(statusFile(dir), artifactPath(label + '-status.json')); } catch (e) { /* none */ }
  try { fs.copyFileSync(logFile(dir), artifactPath(label + '-B-Side.log')); } catch (e) { /* none */ }
}

module.exports = {
  ROOT, IS_WIN, EXE, ARTIFACTS, VIDEO, PLAYLIST, BLOCK_CODES,
  sleep, waitFor, artifactPath, writeJson, mergeJson,
  launchApp, runCmd, status, statusViaCmd, readStatusFile, statusFile, logFile, logText,
  playerPages, mainPlayer, playerSnapshot, youtubeDiagnosis, classifyBlock, waitForPlaying, YouTubeBlocked,
  desktopShot, nativeHandle, describeWallpaper, probeWindow, closeApp, copyEvidence, mainProcessIds, newUserDataDir, baseEnv, command
};
