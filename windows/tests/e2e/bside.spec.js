'use strict';
// End-to-end tests for B-Side for Windows, run against the real app (the packaged exe on CI, `electron .` on a Mac).
// Eight checks from windows/PLAN.md. Tests that need YouTube to play carry "[needs-youtube]" in the title, so that a
// datacentre IP block can be told apart from an app fault (see tools/ci-verdict.js).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const pkg = require('../../package.json');
const VIDEO_ID = (H.VIDEO.match(/v=([\w-]{11})/) || [])[1];
const WALL_CLASSES = ['WorkerW', 'Progman'];

let A = null;                 // { app, userDataDir, pid, exe }
let panelPage = null;
const results = {};           // title -> outcome, written to e2e-summary.json

test.describe.configure({ mode: 'default', timeout: 240000 });

async function pageSnap() { return H.playerSnapshot(await H.mainPlayer(A.app)); }
async function cmd(c) {
  const r = await H.runCmd(A.userDataDir, c);
  expect(r.code, '`--cmd ' + c + '` exit code. Output: ' + r.out).toBe(0);
  return r;
}

// Playwright starts a fresh worker (and so runs beforeAll again) after any failed test. Every test therefore makes sure
// the app is playing something before it starts, instead of relying on an earlier test having done it.
async function ensureOn() {
  const s = await H.status(A.userDataDir);
  if (!s || !s.on) await cmd('url:' + H.VIDEO);
  await H.waitFor(async () => { const t = await H.status(A.userDataDir); return t && t.on && t.players >= 1 ? t : null; },
    { timeout: 20000, message: 'the app to be on with at least one player' });
}

test.beforeAll(async () => {
  H.desktopShot('desktop-1-before');
  A = await H.launchApp();
  H.writeJson('run-info.json', {
    platform: process.platform, arch: process.arch, node: process.version, exe: A.exe, packaged: !!H.EXE,
    userDataDir: A.userDataDir, pid: A.pid, video: H.VIDEO, playlist: H.PLAYLIST,
    small: H.baseEnv().BSIDE_SMALL, startedAt: new Date().toISOString()
  });
  // The app is running but idle until the first test hands it a link.
  await H.waitFor(async () => { const s = await H.status(A.userDataDir); return s && s.platform ? s : null; },
    { timeout: 30000, message: 'status.json from the freshly launched app' });
});

test.afterEach(async ({}, testInfo) => {
  results[testInfo.title] = { status: testInfo.status, expected: testInfo.expectedStatus, ms: testInfo.duration,
                              error: testInfo.error ? String(testInfo.error.message || testInfo.error).slice(0, 1500) : null };
});

test.afterAll(async () => {
  if (A) {
    H.copyEvidence(A.userDataDir, 'app');
    try { fs.writeFileSync(H.artifactPath('processes-at-end.json'), JSON.stringify(H.mainProcessIds(A.userDataDir))); } catch (e) { /* ignore */ }
    await H.closeApp(A);
  }
  H.desktopShot('desktop-4-after');
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(H.artifactPath('e2e-summary.json'), 'utf8')).tests || {}; } catch (e) { /* first worker */ }
  H.mergeJson('e2e-summary.json', { finishedAt: new Date().toISOString(), tests: Object.assign(prior, results) });
  // Leave a negative marker so the verdict script can tell "played fine" from "never got that far".
  if (!fs.existsSync(H.artifactPath('youtube-status.json'))) H.writeJson('youtube-status.json', { 'blocked-by-youtube': false, note: 'no player was ever refused' });
});

test('1. launches once, and a second launch hands over to the first and exits', async () => {
  expect(H.mainProcessIds(A.userDataDir), 'copies of the app running before the second launch').toEqual([A.pid]);
  const s0 = await H.status(A.userDataDir);
  expect(s0.panelOpen, 'test mode skips the first-run panel').toBe(false);
  expect(s0.on).toBe(false);

  const r = await H.runCmd(A.userDataDir, 'panel');
  expect(r.code, 'the second launch must exit cleanly. Output: ' + r.out).toBe(0);
  expect(r.signal).toBeNull();
  expect(r.ms, 'the second launch should hand over and leave quickly').toBeLessThan(40000);

  const s1 = await H.waitFor(async () => { const s = await H.status(A.userDataDir); return s && s.panelOpen ? s : null; },
    { timeout: 15000, message: 'the first copy to open its panel after the second launch said "panel"' });
  expect(s1.panelOpen).toBe(true);
  expect(H.logText(A.userDataDir)).toContain('second launch, command "panel"');
  // Still exactly one copy, and it is the one we started.
  expect(H.mainProcessIds(A.userDataDir)).toEqual([A.pid]);

  panelPage = await H.waitFor(() => A.app.windows().find((p) => /panel\.html/.test(p.url())) || null, { timeout: 15000, message: 'the panel window' });
});

test('2. plays an official video: state 1 and the clock moves [needs-youtube]', async () => {
  await cmd('url:' + H.VIDEO);
  const { page, snap } = await H.waitForPlaying(A.app, A.userDataDir);
  expect(snap.s, 'YT player state 1 means playing').toBe(1);
  expect(snap.id).toBe(VIDEO_ID);
  H.mergeJson('youtube-status.json', { 'blocked-by-youtube': false });

  // The app reads the player once a second, so give status a moment to catch up with the page.
  const st1 = await H.waitFor(async () => { const t = await H.statusViaCmd(A.userDataDir); return t.now && t.now.playing ? t : null; },
    { timeout: 20000, interval: 500, message: 'status.now.playing to turn true' });
  expect(st1.on).toBe(true);
  expect(st1.now.id).toBe(VIDEO_ID);

  const a = await H.playerSnapshot(page);
  await H.sleep(5000);
  const b = await H.playerSnapshot(page);
  expect(b.s, 'still playing 5 s later').toBe(1);
  expect(b.t, 'currentTime must strictly increase (a=' + a.t + ', b=' + b.t + ')').toBeGreaterThan(a.t + 3);
  const st2 = await H.statusViaCmd(A.userDataDir);
  expect(st2.now.t, 'status.now.t must have moved on too').toBeGreaterThan(st1.now.t);
  H.writeJson('playback.json', { id: snap.id, title: snap.title, duration: snap.d, t_first: a.t, t_5s_later: b.t, status_t: [st1.now.t, st2.now.t] });
});

test('3a. one player window per screen, and status has the documented shape', async () => {
  await ensureOn();
  const st = await H.statusViaCmd(A.userDataDir);
  const keys = ['on', 'mode', 'error', 'pausedBy', 'screens', 'now', 'settings', 'recents', 'canResume', 'version', 'players',
                'followers', 'panelOpen', 'shortcuts', 'wallpaper', 'platform'];
  for (const k of keys) expect(Object.prototype.hasOwnProperty.call(st, k), 'status.' + k + ' is present').toBe(true);
  expect(st.platform).toBe(process.platform);
  expect(st.version).toBe(pkg.version);
  expect(st.settings.screens).toBe('all');
  expect(st.players, 'one player per screen').toBe(st.screens);
  expect(H.playerPages(A.app).length, 'player windows Playwright can see').toBe(st.players);
  expect(st.followers.length).toBe(st.players - 1);
  expect(st.shortcuts).toEqual(expect.objectContaining({ enabled: expect.any(Boolean), registered: expect.any(Array), failed: expect.any(Array) }));
  expect(Object.keys(st.wallpaper).sort()).toEqual(['method', 'parentClass']);
  H.writeJson('status-shape.json', st);
});

test('3b. followers sit on the main player\'s video [needs-youtube]', async () => {
  await ensureOn();
  const st = await H.statusViaCmd(A.userDataDir);
  test.info().annotations.push({ type: 'screens', description: String(st.screens) });
  if (st.followers.length === 0) {
    // One display: nothing to follow. Multi-monitor cannot be proven here and the README says so.
    expect(st.players).toBe(1);
    test.info().annotations.push({ type: 'limit', description: 'single display, follower sync not exercised' });
    return;
  }
  await H.waitFor(async () => {
    const s = await H.statusViaCmd(A.userDataDir);
    return s.now && s.followers.every((id) => id === s.now.id);
  }, { timeout: 40000, interval: 1500, message: 'every follower to show the main video id' });
});

test('5. wallpaper attach: the player window is parented to WorkerW or Progman', async () => {
  await ensureOn();
  const st = await H.waitFor(async () => {
    const s = await H.status(A.userDataDir);
    return s && s.on && (!H.IS_WIN || s.wallpaper.method !== 'none') ? s : null;
  }, { timeout: 30000, message: 'the wallpaper to attach (status.wallpaper.method)' });
  expect(st.mode).toBe('wallpaper');
  H.desktopShot('desktop-2-wallpaper');

  if (!H.IS_WIN) {
    // The stub contract from PLAN.md: off Windows nothing attaches and nothing throws.
    expect(st.wallpaper).toEqual({ method: 'none', parentClass: '' });
    test.skip(true, 'Win32 parenting (WorkerW/Progman) can only be checked on Windows; the stub contract was asserted above');
  }

  const described = await H.describeWallpaper(A.app);
  H.mergeJson('wallpaper.json', { reported: st.wallpaper, describe: described });
  const where = 'app reports ' + JSON.stringify(st.wallpaper) + '; wallpaper.describe() says ' + JSON.stringify(described);
  const hwnd = await H.nativeHandle(A.app, false);
  expect(hwnd, 'native handle of the main player. ' + where).toBeTruthy();
  const probe = H.probeWindow(hwnd);
  H.mergeJson('wallpaper.json', { probe, hwnd });
  expect(probe.exists, 'the window exists. ' + where).toBe(true);
  expect(probe.visible, 'the window is visible. ' + where).toBe(true);
  expect(probe.topmost, 'a wallpaper must not be topmost. ' + where).toBe(false);

  if (st.wallpaper.method === 'bottom') {
    // Allowed fallback (the shell layer was not reachable). The window is still behind everything, so this is a warning, not a pass.
    test.info().annotations.push({ type: 'WARN', description: 'wallpaper fell back to the bottom-most window, not WorkerW/Progman. ' + where });
    console.warn('WARN wallpaper method is bottom. ' + where);
    return;
  }
  expect(['workerw', 'progman-child'], 'attach method. ' + where).toContain(st.wallpaper.method);
  expect(WALL_CLASSES, 'class the app says it parented under. ' + where).toContain(st.wallpaper.parentClass);
  // Do not take the app's word for it: ask Windows.
  expect(probe.isChild, 'WS_CHILD set after re-parenting. ' + where + '; user32 says ' + JSON.stringify(probe)).toBe(true);
  expect(WALL_CLASSES, 'GetParent class from user32. ' + where + '; user32 says ' + JSON.stringify(probe)).toContain(probe.parentClass);
});

test('4. controls: pause, play, mute, volume and mode show up in status; next and prev move through a playlist [needs-youtube]', async () => {
  await ensureOn();
  await H.waitForPlaying(A.app, A.userDataDir);
  const st = async () => H.status(A.userDataDir);
  const until = (fn, message) => H.waitFor(async () => fn(await st()), { timeout: 15000, interval: 400, message });

  await cmd('pause');
  await until((s) => s.now && s.now.playing === false, 'status.now.playing false after pause');
  expect((await pageSnap()).s, 'YT player state 2 means paused').toBe(2);
  const p1 = await pageSnap(); await H.sleep(2000); const p2 = await pageSnap();
  expect(p2.t, 'the clock stops while paused').toBeLessThan(p1.t + 1);
  await cmd('play');
  await until((s) => s.now && s.now.playing === true, 'status.now.playing true after play');
  expect((await pageSnap()).s).toBe(1);

  await cmd('mute');
  await until((s) => s.settings.muted === true, 'settings.muted true');
  expect((await pageSnap()).muted).toBe(true);
  await cmd('mute');
  await until((s) => s.settings.muted === false, 'settings.muted false');
  expect((await pageSnap()).muted).toBe(false);

  await cmd('vol:30');
  await until((s) => s.settings.volume === 30 && s.settings.muted === false, 'settings.volume 30');
  expect((await pageSnap()).v).toBe(30);
  await cmd('louder');
  await until((s) => s.settings.volume === 40, 'settings.volume 40 after louder');
  await cmd('quieter');
  await until((s) => s.settings.volume === 30, 'settings.volume 30 after quieter');
  await cmd('set:dim=25');
  await until((s) => s.settings.dim === 25, 'settings.dim 25');
  await cmd('set:dim=0');
  await until((s) => s.settings.dim === 0, 'settings.dim 0');

  await cmd('mode:screensaver');
  await until((s) => s.mode === 'screensaver', 'status.mode screensaver');
  await cmd('mode:wallpaper');
  await until((s) => s.mode === 'wallpaper', 'status.mode wallpaper');

  // Playlist: next must change the video, prev must come back to it.
  await cmd('url:' + H.PLAYLIST);
  const first = (await H.waitForPlaying(A.app, A.userDataDir)).snap;
  const stList = await H.statusViaCmd(A.userDataDir);
  expect(stList.now.list, 'status.now.list is true for a playlist link').toBe(true);
  // The clips in this playlist are short and move on by themselves, so watch the playlist index at a fast poll
  // (an automatic advance can only raise it, next must raise it, prev must lower it).
  const idx0 = (await pageSnap()).idx;
  await cmd('next');
  const second = await H.waitFor(async () => { const t = await pageSnap(); return t.ready && (t.idx > idx0 || t.id !== first.id) ? t : null; },
    { timeout: 60000, interval: 300, message: 'the playlist to move on after next (index ' + idx0 + ', first video ' + first.id + ')' });
  expect(second.id).not.toBe(first.id);
  await H.waitFor(async () => { const t = await pageSnap(); return t.ready && t.s === 1 ? t : null; }, { timeout: 60000, interval: 500, message: 'the next video to play' });
  const idxB = (await pageSnap()).idx;
  expect(idxB, 'playlist index after next').toBeGreaterThan(idx0);
  await cmd('prev');
  await H.waitFor(async () => { const t = await pageSnap(); return t.ready && t.idx < idxB ? t : null; },
    { timeout: 60000, interval: 300, message: 'the playlist index to drop below ' + idxB + ' after prev' });
});

test('6. screensaver: top-most, covers the display, ignores a click in the grace period, ends on a click after it', async () => {
  await ensureOn();
  const mainWin = (fn, arg) => A.app.evaluate(fn, arg);
  const winState = () => mainWin(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('localhost.bside/player?f=0'));
    if (!w) return null;
    const b = w.getBounds(), d = screen.getDisplayMatching(b);
    return { top: w.isAlwaysOnTop(), full: w.isFullScreen(), visible: w.isVisible(), bounds: b, display: d.bounds };
  });

  if (!panelPage) { await cmd('panel'); panelPage = await H.waitFor(() => A.app.windows().find((p) => /panel\.html/.test(p.url())) || null, { timeout: 15000, message: 'the panel window' }); }
  // Enter through the panel, the way a person would, so the 3 s grace period can be tested without a slow round trip.
  await panelPage.evaluate(() => window.bside.send('screensaver'));
  const entered = await H.waitFor(async () => { const w = await winState(); return w && w.top ? w : null; }, { timeout: 8000, interval: 40, message: 'the player to become top-most' });
  const t0 = Date.now();
  const clickLater = () => mainWin(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('localhost.bside/player?f=0'));
    w.webContents.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 });
  });

  await clickLater();    // inside the 3 s grace period: must be ignored
  const sinceEnter = Date.now() - t0;
  await H.sleep(1500);
  const during = await H.status(A.userDataDir);
  expect(during.mode, 'a click ' + sinceEnter + ' ms after the saver started must be ignored').toBe('screensaver');
  expect(entered.visible).toBe(true);
  const small = H.baseEnv().BSIDE_SMALL === '1';
  if (small) {
    expect(entered.bounds.width).toBeLessThanOrEqual(640);    // small windows on a Mac: never fullscreen
  } else {
    expect(entered.bounds, 'screensaver window covers its display').toEqual(entered.display);
  }
  if (H.IS_WIN && !small) {
    expect(entered.full, 'full-screen window on Windows').toBe(true);
    const probe = H.probeWindow(await H.nativeHandle(A.app, false));
    H.mergeJson('screensaver.json', { entered, probe });
    expect(probe.topmost, 'WS_EX_TOPMOST from user32: ' + JSON.stringify(probe)).toBe(true);
    H.desktopShot('desktop-3-screensaver');
  }

  await H.sleep(Math.max(0, 3400 - (Date.now() - t0)));    // grace period over
  await clickLater();
  await H.waitFor(async () => { const s = await H.status(A.userDataDir); return s && s.mode === 'wallpaper' ? s : null; },
    { timeout: 10000, interval: 300, message: 'the screensaver to end on a click after the grace period' });
  const after = await winState();
  expect(after.top, 'no longer top-most').toBe(false);
  expect((await H.status(A.userDataDir)).on, 'the video keeps going after the saver ends').toBe(true);
});

test('7. a bad link shows an error and playback carries on [needs-youtube]', async () => {
  await ensureOn();
  // The playlist clips are a few seconds long and move on by themselves, so use the long video for this check.
  await cmd('url:' + H.VIDEO);
  await H.waitFor(async () => { const t = await pageSnap(); return t.ready && t.id === VIDEO_ID && t.s === 1 && t.t > 0 ? t : null; },
    { timeout: 90000, interval: 1000, message: 'the long test video to be playing' });
  const before = await pageSnap();
  await cmd('url:https://example.com/this-is-not-a-video');
  const st = await H.waitFor(async () => { const s = await H.status(A.userDataDir); return s && s.error ? s : null; },
    { timeout: 8000, interval: 200, message: 'status.error after a bad link' });
  expect(st.error).toMatch(/youtube/i);
  await H.sleep(4000);
  const after = await pageSnap();
  expect(after.id, 'still the same video').toBe(before.id);
  expect(after.s, 'still playing').toBe(1);
  expect(after.t, 'the clock kept moving (' + before.t + ' to ' + after.t + ')').toBeGreaterThan(before.t + 2);
  const final = await H.status(A.userDataDir);
  expect(final.on).toBe(true);
  expect(final.now.id).toBe(before.id);
});

test('8. screenshots: the desktop before, during and after, plus a frame of the player [needs-youtube]', async () => {
  await ensureOn();
  await H.waitForPlaying(A.app, A.userDataDir);
  const frame = H.artifactPath('player-frame.png');
  await cmd('shot:player:' + frame);
  await H.waitFor(() => fs.existsSync(frame) && fs.statSync(frame).size > 0, { timeout: 15000, message: 'the player frame to be written' });
  const bytes = fs.statSync(frame).size;
  H.mergeJson('screenshots.json', { playerFrameBytes: bytes });
  if (H.IS_WIN) {
    // A solid black frame is a few hundred bytes. On Windows a wallpaper child window may not capture, so this is recorded and a human looks.
    test.info().annotations.push({ type: 'player-frame-bytes', description: String(bytes) });
    for (const n of ['desktop-1-before', 'desktop-2-wallpaper']) {
      const f = H.artifactPath(n + '.png');
      expect(fs.existsSync(f), n + '.png was written').toBe(true);
      expect(fs.statSync(f).size, n + '.png is a real picture, not a blank one').toBeGreaterThan(20000);
    }
  } else {
    expect(bytes, 'a playing video frame is far bigger than a blank one').toBeGreaterThan(15000);
    test.info().annotations.push({ type: 'skipped', description: 'desktop screenshots are taken only on Windows (or with E2E_DESKTOP_SHOT=1)' });
  }
});

test('9. global shortcuts register on Windows (Ctrl+Alt+B, P, S, M, Left, Right)', async () => {
  test.skip(!H.IS_WIN, 'RegisterHotKey is Windows-only, and a Mac run must not grab real key combinations');
  const second = await H.launchApp({ env: { BSIDE_SHORTCUTS: '1' } });
  try {
    const st = await H.waitFor(async () => { const s = await H.status(second.userDataDir); return s && s.platform ? s : null; },
      { timeout: 30000, message: 'status.json from an app started with BSIDE_SHORTCUTS=1' });
    expect(st.shortcuts.enabled).toBe(true);
    expect(st.shortcuts.failed, 'keys another program already owns: ' + JSON.stringify(st.shortcuts)).toEqual([]);
    expect(st.shortcuts.registered.sort()).toEqual(['Ctrl+Alt+B', 'Ctrl+Alt+Left', 'Ctrl+Alt+M', 'Ctrl+Alt+P', 'Ctrl+Alt+Right', 'Ctrl+Alt+S']);
    H.writeJson('shortcuts.json', st.shortcuts);
  } finally {
    await H.closeApp(second);
  }
});

test('10. the bside.cmd shim passes a link with &list= through to the running app, and `bside status` answers', async () => {
  test.skip(!H.IS_WIN, 'bside.cmd needs cmd.exe');
  const { spawn } = require('child_process');
  const shim = H.EXE ? path.join(path.dirname(H.EXE), 'resources', 'bside.cmd') : path.join(H.ROOT, 'bin', 'bside.cmd');
  expect(fs.existsSync(shim), 'the shim is shipped at ' + shim).toBe(true);
  const exeDir = H.EXE ? path.dirname(H.EXE) : null;

  // The shim cannot pass --user-data-dir, so this copy runs with the default data folder, as a user's would.
  const third = await H.launchApp({ defaultUserData: true });
  try {
    await H.waitFor(async () => { const s = await H.status(third.userDataDir); return s && s.platform ? s : null; }, { timeout: 30000, message: 'status.json from the default-folder app' });
    const env = Object.assign({}, H.baseEnv());
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
    if (exeDir) env[pathKey] = exeDir + ';' + (env[pathKey] || '');
    const runShim = (arg) => new Promise((resolve) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', '""' + shim + '" ' + arg + '"'], { env, windowsVerbatimArguments: true, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 60000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    const list = 'PL0BAFA2DA294B0900';
    const link = 'https://www.youtube.com/watch?v=dhzPnX07jAs&list=' + list;
    const r = await runShim('"' + link + '"');
    expect(r.code, 'shim exit code. Output: ' + r.out).toBe(0);

    // The link must have arrived whole: the &list= part is the part cmd.exe is most likely to eat.
    const state = await H.waitFor(() => {
      try { const j = JSON.parse(fs.readFileSync(path.join(third.userDataDir, 'state.json'), 'utf8')); return j.last && j.last.url.includes('list=' + list) ? j : null; } catch (e) { return null; }
    }, { timeout: 20000, message: 'state.json to hold the link with list=' + list + ' (the shim may have cut it at the &)' });
    expect(state.last.url).toContain('v=dhzPnX07jAs');
    const st = await H.waitFor(async () => { const s = await H.statusViaCmd(third.userDataDir); return s.on && s.now && s.now.list ? s : null; },
      { timeout: 30000, interval: 1000, message: '--cmd=status to show a playing playlist (now.list true)' });
    expect(st.now.list).toBe(true);

    const s2 = await runShim('status');
    expect(s2.code, 'bside status exit code. Output: ' + s2.out).toBe(0);
    const parsed = JSON.parse(s2.out.slice(s2.out.indexOf('{')));
    expect(parsed.platform).toBe('win32');
    expect(parsed.on).toBe(true);
    H.writeJson('shim.json', { shim, link, lastUrl: state.last.url, statusViaShim: parsed.now });
  } finally {
    await H.closeApp(third);
  }
});
