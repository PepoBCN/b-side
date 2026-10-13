// B-Side: plays a YouTube video, playlist or mix as the desktop wallpaper on every screen,
// with sound from the main screen. Built by build.sh into a stay-open JXA applet.
//
// Control surfaces, all routed through command():
//   control panel (panel.html, WKScriptMessageHandler "yt")
//   Dock icon and menu bar icon (both open the panel)
//   `bside <command>` (distributed notification "bside.cmd")
//   global keyboard shortcuts (NSEvent monitors, ⌃⌥ + key)

ObjC.import('Cocoa');
ObjC.import('WebKit');
ObjC.import('ApplicationServices');   // AXIsProcessTrustedWithOptions

const APP_NAME = 'B-Side';
const BUNDLE_ID = 'com.feldberg.bside';
const ORIGIN = 'https://localhost.bside';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const SUPPORT_DIR = ObjC.unwrap($('~/Library/Application Support/B-Side').stringByExpandingTildeInPath);
const STATE_FILE = SUPPORT_DIR + '/state.json';
const STATUS_FILE = SUPPORT_DIR + '/status.json';
const LOG_FILE = ObjC.unwrap($('~/Library/Logs/B-Side.log').stringByExpandingTildeInPath);
const AGENT_FILE = ObjC.unwrap($('~/Library/LaunchAgents/com.feldberg.bside.plist').stringByExpandingTildeInPath);

const VERSION = (function () { try { return ObjC.unwrap($.NSBundle.mainBundle.objectForInfoDictionaryKey('CFBundleShortVersionString')) || ''; } catch (e) { return ''; } })();

const sa = Application.currentApplication();
sa.includeStandardAdditions = true;

// Append a line to ~/Library/Logs/B-Side.log.
function log(msg) {
  try {
    const fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(LOG_FILE)) fm.createFileAtPathContentsAttributes(LOG_FILE, $(), $());
    const h = $.NSFileHandle.fileHandleForWritingAtPath(LOG_FILE);
    h.seekToEndOfFile;
    h.writeData($(new Date().toISOString() + ' ' + msg + '\n').dataUsingEncoding(4));
    h.closeFile;
  } catch (e) {}
}

// ---------------------------------------------------------------- state

const DEFAULTS = {
  volume: 80, muted: false, dim: 0, fill: true, screens: 'all',
  pauseOnLock: true, pauseOnBattery: false, idleSaver: 0,
  resumeOnLaunch: false, launchAtLogin: false, closeChromeTab: true, skipStill: true, shortcuts: true
};

var settings = Object.assign({}, DEFAULTS);
const RECENTS_MAX = 8;
var recents = [];          // [{id, list, title}], newest first, at most RECENTS_MAX
var last = null;           // {url}
var axPrompted = false;    // asked macOS for Accessibility access once already
var on = false;            // wallpaper showing
var mode = 'wallpaper';    // 'wallpaper' | 'screensaver'
var current = null;        // url being played
var main = {};             // last status reported by the main player
var error = null, errorAt = 0, playerError = null;
function setError(msg) { error = msg; errorAt = Date.now(); }
var pausedBy = null;       // 'lock' | 'battery' | null
var saverSince = 0;
var chromeTab = null;      // {url, title} of a YouTube tab open in Chrome
var tick = 0;

// Live ObjC objects must stay referenced or JXA frees them.
var mainState = null, ytSignedIn = false, accountBuilt = false, signinWin = null, playerHandler = null;   // 'Use my YouTube account' mode
var ctrl, panelHandler, item, panel, panelWeb, wins = [], views = [], catchers = [], layout = '';

function loadState() {
  const old = ObjC.unwrap($('~/Library/Application Support/YouTube Wallpaper/state.json').stringByExpandingTildeInPath);
  const fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(STATE_FILE) && fm.fileExistsAtPath(old)) {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(SUPPORT_DIR, true, $(), null);
    fm.copyItemAtPathToPathError(old, STATE_FILE, null);
  }
  try {
    const s = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(STATE_FILE, 4, null)));
    settings = Object.assign({}, DEFAULTS, s.settings || {});
    recents = (s.recents || []).slice(0, RECENTS_MAX);
    last = s.last || null;
    axPrompted = !!s.axPrompted;
  } catch (e) {}
}

function saveState() {
  try {
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(SUPPORT_DIR, true, $(), null);
    $(JSON.stringify({ settings: settings, recents: recents, last: last, axPrompted: axPrompted }, null, 1))
      .writeToFileAtomicallyEncodingError(STATE_FILE, true, 4, null);
  } catch (e) {}
}

// ---------------------------------------------------------------- urls

function parseUrl(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
  const l = url.match(/[?&]list=([\w-]+)/);
  const t = url.match(/[?&#](?:t|start)=(\d+)/);
  return { id: m ? m[1] : null, list: l ? l[1] : null, t: t ? parseInt(t[1], 10) : 0 };
}

function watchUrl(id, list, t, index) {
  let u = 'https://www.youtube.com/watch?v=' + id;
  if (t) u += '&t=' + t + 's';
  if (list) u += '&list=' + list + (index >= 0 ? '&index=' + (index + 1) : '');
  return u;
}

// ---------------------------------------------------------------- player page

// The main player owns the playlist and the sound. Followers (other screens) are muted and
// copy whatever the main player shows, because YouTube mixes reshuffle on every load.
function playerPage(url, follower) {
  const p = parseUrl(url);
  // Embed URL form, so a playlist or mix starts on this video rather than at its first track.
  const q = { enablejsapi: 1, autoplay: 1, controls: 0, cc_load_policy: 0, rel: 0, playsinline: 1, iv_load_policy: 3,
              fs: 0, disablekb: 1, origin: ORIGIN };
  if (p.t) q.start = p.t;
  if (!p.id) q.list = p.list;   // a playlist link with no video: start at its first track
  else if (!follower) {
    if (p.list) q.list = p.list; else { q.loop = 1; q.playlist = p.id; }
  }
  const src = 'https://www.youtube.com/embed/' + (p.id || 'videoseries') + '?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  const cfg = { id: p.id, list: p.list || '', follower: follower,
                volume: settings.volume, muted: settings.muted, dim: settings.dim, fill: settings.fill };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
#wrap{position:fixed;inset:0;overflow:hidden}
#p{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100vw;height:100vh;border:0}
body.fill #p{width:max(100vw,177.78vh);height:max(100vh,56.25vw)}
#dim{position:fixed;inset:0;background:#000;pointer-events:none;opacity:0;transition:opacity .3s}
</style></head><body><div id="wrap"><iframe id="p" src="${src}" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div id="dim"></div><script>
var C=${JSON.stringify(cfg)},player,ready=false,err=null;
function nocc(){try{player.unloadModule("captions");player.unloadModule("cc");}catch(e){}}
function setLook(dim,fill){document.getElementById("dim").style.opacity=dim/100;document.body.classList.toggle("fill",!!fill);}
setLook(C.dim,C.fill);
function onYouTubeIframeAPIReady(){
  player=new YT.Player("p",{events:{
    onReady:function(e){ready=true;nocc();
      if(C.follower||C.muted)e.target.mute();else{e.target.unMute();e.target.setVolume(C.volume);}
      e.target.playVideo();},
    onStateChange:function(e){nocc();if(e.data==1)err=null;},
    onApiChange:nocc,
    onError:function(e){err=e.data;if(!C.follower&&C.list)setTimeout(function(){player.nextVideo();},1500);}
  }});
}
function report(){try{var d=player.getVideoData();document.title=JSON.stringify({id:d.video_id,title:d.title,author:d.author,
  t:Math.floor(player.getCurrentTime()),d:Math.floor(player.getDuration()),s:player.getPlayerState(),
  i:player.getPlaylistIndex(),m:player.isMuted(),v:player.getVolume(),err:err});}catch(e){}}
setInterval(report,1000);
function toggle(){var st=player.getPlayerState();st==1||st==3||st==-1?player.pauseVideo():player.playVideo();}
function setVol(v){player.setVolume(v);if(v>0)player.unMute();}
function setMuted(m){m?player.mute():player.unMute();}
function follow(id,t,st){if(!ready)return;var d=player.getVideoData();
  if(d.video_id!==id){player.loadVideoById(id,t);return;}
  if(Math.abs(player.getCurrentTime()-t)>2)player.seekTo(t,true);
  var me=player.getPlayerState();if(st==2&&me==1)player.pauseVideo();if(st==1&&me!=1)player.playVideo();}
</script><script src="https://www.youtube.com/iframe_api"></script></body></html>`;
}

function evalIn(view, code) {
  try { view.evaluateJavaScriptCompletionHandler(code, function (r, e) {}); } catch (e) {}
}
function jsMain(code) { if (views[0]) evalIn(views[0], code); }
function jsAll(code) { views.forEach(function (v) { evalIn(v, code); }); }

// ---------------------------------------------------------------- windows

ObjC.registerSubclass({
  name: 'BSideWindow', superclass: 'NSWindow',
  methods: {
    'canBecomeKeyWindow': { types: ['bool', []], implementation: function () { return true; } },
    'keyDown:': { types: ['void', ['id']], implementation: function () { exitSaver('key'); } }
  }
});

// Sits over the video in screensaver mode and ends it on click or mouse movement.
ObjC.registerSubclass({
  name: 'BSideClickCatcher', superclass: 'NSView',
  methods: {
    'acceptsFirstResponder': { types: ['bool', []], implementation: function () { return true; } },
    'acceptsFirstMouse:': { types: ['bool', ['id']], implementation: function () { return true; } },
    'mouseDown:': { types: ['void', ['id']], implementation: function () { exitSaver('click'); } },
    'rightMouseDown:': { types: ['void', ['id']], implementation: function () { exitSaver('click'); } },
    'mouseMoved:': { types: ['void', ['id']], implementation: function (ev) {
      try { saverMoved(Math.abs(ev.deltaX) + Math.abs(ev.deltaY)); } catch (e) {} } },
    'keyDown:': { types: ['void', ['id']], implementation: function () { exitSaver('key'); } }
  }
});

function screenLayout() {
  const s = $.NSScreen.screens, out = [];
  const n = settings.screens === 'main' ? 1 : s.count;
  for (let i = 0; i < n; i++) {
    const f = s.objectAtIndex(i).frame;
    out.push([f.origin.x, f.origin.y, f.size.width, f.size.height].join(','));
  }
  return out.join('|');
}

function teardown() {
  // Silence the old players first, or they keep playing unseen.
  views.forEach(function (w) { try { w.stopLoading; w.loadHTMLStringBaseURL('', $()); w.removeFromSuperview; } catch (e) {} });
  wins.forEach(function (w) { try { w.orderOut(null); w.close; } catch (e) {} });
  wins = []; views = []; catchers = []; layout = '';
}

// One borderless window per screen at desktop level. Screen 0 is the menu bar screen and carries the sound.
function build(force) {
  if (!on) return;
  const now = screenLayout();
  if (!force && now === layout) return;
  teardown();
  layout = now;
  const s = $.NSScreen.screens;
  const n = settings.screens === 'main' ? 1 : s.count;
  for (let i = 0; i < n; i++) {
    const frame = s.objectAtIndex(i).frame;
    const win = $.BSideWindow.alloc.initWithContentRectStyleMaskBackingDefer(frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    win.releasedWhenClosed = false;
    win.setFrameDisplay(frame, true);
    win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary | $.NSWindowCollectionBehaviorIgnoresCycle;
    win.backgroundColor = $.NSColor.blackColor;
    win.hasShadow = false;
    win.acceptsMouseMovedEvents = true;

    const cfg = $.WKWebViewConfiguration.alloc.init;
    cfg.mediaTypesRequiringUserActionForPlayback = 0;
    const account = i === 0 && ytSignedIn;
    if (i === 0) accountBuilt = account;
    if (account) {
      if (!playerHandler) playerHandler = $.BSidePlayerHandler.alloc.init;
      cfg.userContentController.addUserScript($.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly(watchScript(), 0, true));
      cfg.userContentController.addScriptMessageHandlerName(playerHandler, 'bsideplayer');
    }
    const web = $.WKWebView.alloc.initWithFrameConfiguration(win.contentView.bounds, cfg);
    web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
    web.customUserAgent = UA;
    win.contentView.addSubview(web);

    const catcher = $.BSideClickCatcher.alloc.initWithFrame(win.contentView.bounds);
    catcher.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
    win.contentView.addSubview(catcher);

    wins.push(win); views.push(web); catchers.push(catcher);
    if (account) { mainState = null; web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(accountUrl(current)))); }
    else web.loadHTMLStringBaseURL(playerPage(current, i > 0), $.NSURL.URLWithString(ORIGIN + '/'));
  }
  applyMode();
}

function applyMode() {
  const saver = mode === 'screensaver';
  wins.forEach(function (w, i) {
    w.level = $.CGWindowLevelForKey(saver ? $.kCGScreenSaverWindowLevelKey : $.kCGDesktopWindowLevelKey);
    w.ignoresMouseEvents = !saver;
    catchers[i].hidden = !saver;
    if (saver) { w.makeKeyAndOrderFront(null); w.makeFirstResponder(catchers[i]); } else w.orderBack(null);
  });
  if (saver) {
    saverSince = Date.now(); saverMove = 0;
    if (panel) panel.orderOut(null);
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    $.NSCursor.setHiddenUntilMouseMoves(true);
  }
}

function setMode(m) {
  if (m !== 'wallpaper' && m !== 'screensaver') return;
  if (m === mode) return;
  log('mode ' + m);
  mode = m;
  if (on) applyMode();
}

// Screensaver mode ignores input for its first few seconds, then ends on a click, a key or a
// deliberate mouse move. A nudge of the trackpad while walking away doesn't count.
const SAVER_GRACE_MS = 3000, SAVER_MOVE_PX = 120;
var saverMove = 0, saverMoveAt = 0;
function saverMoved(px) {
  const now = Date.now();
  if (now - saverMoveAt > 1000) saverMove = 0;
  saverMoveAt = now;
  saverMove += px;
  if (saverMove > SAVER_MOVE_PX) exitSaver('mouse move');
}
function exitSaver(reason) {
  if (mode !== 'screensaver' || Date.now() - saverSince < SAVER_GRACE_MS) return;
  log('screensaver ended by ' + reason);
  setMode('wallpaper');
}

// ---------------------------------------------------------------- playback

function start(url, m) {
  const p = parseUrl(url || '');
  if (!p.id && !p.list) { setError('That link is not a YouTube video or playlist.'); return; }
  setError(null);
  current = url;
  main = {};
  playerError = null;
  pausedBy = null;
  stillChecked = null; stillRun = 0;
  if (m) mode = m;
  pauseChrome();
  if (!on) { on = true; build(true); }
  else if (accountBuilt || ytSignedIn) build(true);   // the watch page carries its settings in its user script
  else {
    // Same screens, new video: reload in place.
    views.forEach(function (v, i) { v.loadHTMLStringBaseURL(playerPage(current, i > 0), $.NSURL.URLWithString(ORIGIN + '/')); });
    applyMode();
  }
  last = { url: url };
  saveState();
}

function stop() {
  if (main.id) last = { url: watchUrl(main.id, parseUrl(current || '').list, main.t, main.i) };
  saveState();
  on = false; mode = 'wallpaper'; main = {}; pausedBy = null;
  teardown();
}

function readMain() {
  try {
    const st = JSON.parse(accountBuilt ? mainState : ObjC.unwrap(views[0].title));
    if (st && st.id) {
      main = st;
      if (st.title) rememberRecent(st.id, parseUrl(current || '').list, st.title);
      playerError = st.err === 101 || st.err === 150 ? 'The owner of this video blocks playing it outside YouTube.'
                  : st.err ? 'YouTube could not play this video (error ' + st.err + ').'
                  : stillRun >= STILL_MAX && stillCache[st.id] ? 'This mix is mostly audio uploads with a still picture. Start it from an official music video for moving pictures.' : null;
    }
  } catch (e) {}
}

function rememberRecent(id, list, title) {
  const key = list || id;
  if (recents.length && (recents[0].list || recents[0].id) === key && recents[0].title === title) return;
  recents = recents.filter(function (r) { return (r.list || r.id) !== key && r.id !== id; });
  recents.unshift({ id: id, list: list, title: title });
  recents = recents.slice(0, RECENTS_MAX);
  saveState();
}

// ---------------------------------------------------------------- still-picture tracks

// Mixes are full of audio uploads with one still picture. YouTube's three automatic thumbnails
// (1.jpg, 2.jpg, 3.jpg) come from about a quarter, half and three quarters through a video:
// if they barely differ, the video is a still. Moving videos score 50 and up, stills under 5.
// curl fetches them in the background so the panel never stalls.
const STILL_MAX = 3;           // skip at most this many in a row, so an all-stills mix still plays
const STILL_DIFF = 10;
const STILL_DIR = ObjC.unwrap($.NSTemporaryDirectory()) + 'bside-stills';
var stillCache = {}, stillChecked = null, stillRun = 0, stillJob = null;

function skipStills() {
  if (!settings.skipStill || !main.id || !parseUrl(current || '').list) return;
  if (stillJob) { if (!stillJob.task.isRunning) finishStillJob(); return; }
  if (main.id === stillChecked) return;
  if (main.id in stillCache || / - Topic$/.test(main.author || '')) { stillChecked = main.id; decideStill(main.id, stillCache[main.id] || / - Topic$/.test(main.author || '')); return; }
  const id = main.id, dir = STILL_DIR + '/' + id;
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
  const args = ['-s', '-m', '8'];
  [1, 2, 3].forEach(function (n) { args.push('-o', dir + '/' + n + '.jpg', 'https://i.ytimg.com/vi/' + id + '/' + n + '.jpg'); });
  const task = $.NSTask.alloc.init;
  task.launchPath = '/usr/bin/curl';
  task.arguments = $(args);
  task.launch;
  stillJob = { id: id, dir: dir, task: task };
}

function finishStillJob() {
  const job = stillJob; stillJob = null;
  let score = null;
  try {
    const f = [1, 2, 3].map(function (n) { return frameSample(job.dir + '/' + n + '.jpg'); });
    if (f[0] && f[1] && f[2]) score = Math.max(frameDiff(f[0], f[1]), frameDiff(f[1], f[2]), frameDiff(f[0], f[2]));
  } catch (e) { log('still check ' + job.id + ': ' + e); }
  $.NSFileManager.defaultManager.removeItemAtPathError(job.dir, null);
  stillCache[job.id] = score !== null && score < STILL_DIFF;
  if (job.id !== main.id) return;   // the track changed while we looked; check the new one next tick
  stillChecked = job.id;
  decideStill(job.id, stillCache[job.id]);
}

function decideStill(id, still) {
  if (!still) { stillRun = 0; return; }
  if (stillRun >= STILL_MAX) return;
  stillRun++;
  log('skipping still track ' + id + ' ' + (main.title || ''));
  jsMain('player.nextVideo()');
}

// Brightness on a 16 x 12 grid of a thumbnail.
function frameSample(path) {
  const data = $.NSData.dataWithContentsOfFile(path);
  if (data.isNil() || !data.length) return null;
  const rep = $.NSBitmapImageRep.imageRepWithData(data);
  if (rep.isNil()) return null;
  const w = rep.pixelsWide, h = rep.pixelsHigh, out = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const c = rep.colorAtXY(Math.floor((x + .5) * w / 16), Math.floor((y + .5) * h / 12));
    out.push(c.isNil() ? 0 : c.brightnessComponent * 255);
  }
  return out;
}
function frameDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// Keep the other screens on the main screen's video, second and play state.
function syncFollowers() {
  if (views.length < 2 || !main.id) return;
  const code = 'follow(' + JSON.stringify(main.id) + ',' + main.t + ',' + main.s + ')';
  for (let i = 1; i < views.length; i++) evalIn(views[i], code);
}

// ---------------------------------------------------------------- Chrome hand-off

function chromeRunning() {
  try { return Application('Google Chrome').running(); } catch (e) { return false; }
}

function findChromeTab() {
  if (!chromeRunning()) return null;
  const front = frontChromeTab();   // the tab you're looking at wins over any other YouTube tab
  if (front) return front;
  try {
    const chrome = Application('Google Chrome');
    const ws = chrome.windows();
    for (let i = 0; i < ws.length; i++) {
      const tabs = ws[i].tabs();
      for (let j = 0; j < tabs.length; j++) {
        const u = tabs[j].url();
        if (/youtube\.com\/(watch|shorts|live)|youtu\.be\//.test(u)) return { tab: tabs[j], url: u, title: tabs[j].title() };
      }
    }
  } catch (e) { log('findChromeTab: ' + e); }
  return null;
}

// The tab the user is looking at in Chrome's front window, if it's a YouTube video or playlist.
function frontChromeTab() {
  if (!chromeRunning()) return null;
  try {
    const ws = Application('Google Chrome').windows();
    if (!ws.length) return null;
    const tab = ws[0].activeTab(), u = tab.url();
    if (/youtube\.com\/(watch|shorts|live|playlist\?)|youtu\.be\//.test(u) && (parseUrl(u).id || parseUrl(u).list)) return { tab: tab, url: u, title: tab.title() };
  } catch (e) { log('frontChromeTab: ' + e); }
  return null;
}

// When B-Side starts playing, anything YouTube in Chrome pauses, so only one thing plays.
// This needs Chrome's View > Developer > Allow JavaScript from Apple Events; without it the panel says how.
var chromeJs = true;
function pauseChrome() {
  if (!chromeRunning()) return;
  try {
    const ws = Application('Google Chrome').windows();
    for (let i = 0; i < ws.length; i++) {
      const tabs = ws[i].tabs();
      for (let j = 0; j < tabs.length; j++) {
        if (!/^https:\/\/(www\.|m\.|music\.)?youtube\.com\//.test(tabs[j].url())) continue;
        try {
          tabs[j].execute({ javascript: 'document.querySelectorAll("video,audio").forEach(function(v){v.pause()});1' });
          chromeJs = true;
        } catch (e) {
          if (/turned off/i.test(String(e))) { chromeJs = false; return; }
        }
      }
    }
  } catch (e) { log('pauseChrome: ' + e); }
}

function takeFromChrome(m, found) {
  found = found || findChromeTab();
  if (!found) { setError('No YouTube video open in Chrome.'); return; }
  let url = found.url;
  // Exact second only if Chrome allows JavaScript from Apple Events (View > Developer).
  try {
    const secs = found.tab.execute({ javascript: 'Math.floor(document.querySelector("video").currentTime)' });
    if (secs) url = url.replace(/[?&]t=\d+s?/, '') + '&t=' + secs;
  } catch (e) {}
  if (settings.closeChromeTab) { try { found.tab.close(); } catch (e) {} }
  chromeTab = null;
  start(url, m || 'wallpaper');
}

function backToChrome() {
  readMain();
  const p = parseUrl(current || '');
  const url = main.id ? watchUrl(main.id, p.list, main.t, main.i) : current;
  stop();
  if (url) sa.doShellScript('open -a "Google Chrome" ' + quoted(url));
}

function quoted(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// ---------------------------------------------------------------- settings with side effects

function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  const d = DEFAULTS[key];
  settings[key] = typeof d === 'boolean' ? (value === true || value === 'true' || value === 'on')
                : typeof d === 'number' ? Math.max(0, Math.min(100, Number(value) || 0)) : String(value);
  if (key === 'volume') { settings.muted = false; jsMain('setVol(' + settings.volume + ')'); }
  if (key === 'muted') jsMain('setMuted(' + settings.muted + ')');
  if (key === 'dim' || key === 'fill') jsAll('setLook(' + settings.dim + ',' + settings.fill + ')');
  if (key === 'screens') build(true);
  if (key === 'skipStill') { stillChecked = null; stillRun = 0; }
  if (key === 'launchAtLogin') writeLoginAgent();
  if (key === 'shortcuts') { if (settings.shortcuts) { axPrompted = false; setupShortcuts(); } else removeShortcuts(); }
  saveState();
}

function writeLoginAgent() {
  try {
    if (settings.launchAtLogin) {
      $(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.feldberg.bside</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>${APP_NAME}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`).writeToFileAtomicallyEncodingError(AGENT_FILE, true, 4, null);
    } else {
      $.NSFileManager.defaultManager.removeItemAtPathError(AGENT_FILE, null);
    }
  } catch (e) {}
}

// ---------------------------------------------------------------- commands

// One entry point for the panel, the menu bar and the CLI. Commands are "name" or "name:value".
function command(raw) {
  try {
    const c = String(raw);
    const i = c.indexOf(':');
    const name = i < 0 ? c : c.slice(0, i);
    const arg = i < 0 ? '' : c.slice(i + 1);
    switch (name) {
      case 'toggle': case 'pause': jsMain('toggle()'); break;
      case 'play': jsMain('player.playVideo()'); break;
      case 'next': jsMain('player.nextVideo()'); break;
      case 'prev': jsMain('player.previousVideo()'); break;
      case 'seek': jsMain('player.seekTo(' + Number(arg) + ',true)'); break;
      case 'mute': setSetting('muted', !settings.muted); break;
      case 'louder': setSetting('volume', settings.volume + 10); break;
      case 'quieter': setSetting('volume', settings.volume - 10); break;
      case 'vol': setSetting('volume', arg); break;
      case 'screensaver': case 'wallpaper':
        if (on) setMode(name); else if (chromeOrLast()) takeOrResume(name); break;
      case 'mode': command(arg); break;
      case 'on': case 'chrome': takeFromChrome(arg || mode); break;
      case 'url': start(arg, mode); break;
      case 'signin': openSignin(); break;
      case 'pasteclip': {
        const clip = ObjC.unwrap($.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString)) || '';
        if (/youtu\.?be/.test(clip)) start(clip.trim(), mode); else setError('The clipboard has no YouTube link.');
        break;
      }
      case 'resume': if (last) start(last.url, 'wallpaper'); break;
      case 'recent': { const r = recents[Number(arg)]; if (r) start(watchUrl(r.id, r.list, 0, -1), mode); break; }
      case 'forget': recents = []; saveState(); break;
      case 'tochrome': case 'off': backToChrome(); break;
      case 'stop': stop(); break;
      case 'set': { const j = arg.indexOf('='); setSetting(arg.slice(0, j), arg.slice(j + 1)); break; }
      case 'panel': togglePanel(true); break;
      case 'hotkey': hotkey(arg); break;
      case 'axsettings': sa.doShellScript('open ' + quoted(AX_SETTINGS_URL)); break;
      case 'status': $(JSON.stringify(panelState(), null, 1)).writeToFileAtomicallyEncodingError(STATUS_FILE, true, 4, null); break;
      case 'hidepanel': if (panel) panel.orderOut(null); break;
      case 'quit': stop(); $.NSApplication.sharedApplication.terminate(null); break;
    }
  } catch (e) { log('command ' + raw + ': ' + e); setError('Something went wrong: ' + e); }
  pushPanel();
}

function chromeOrLast() { return findChromeTab() || last; }
function takeOrResume(m) { if (findChromeTab()) takeFromChrome(m); else if (last) start(last.url, m); }

// ---------------------------------------------------------------- keyboard shortcuts

// ⌃⌥ + key, anywhere. A global NSEvent monitor sees keys pressed in other apps (needs
// Accessibility access); a local one sees them while B-Side itself is in front. Matched on the
// key's position (keyCode) and on ⌃⌥ with no ⇧ or ⌘, so caps lock and the arrows' fn flag don't matter.
// ⌃⌥Space is macOS's "next input source", hence P for play.
const SHORTCUTS = { 11: 'chrome', 35: 'play', 124: 'next', 123: 'prev', 1: 'saver', 46: 'mute' };   // B P → ← S M
const MOD_MASK = 0x1E0000, MOD_CTRL_OPT = 0xC0000;   // ⇧⌃⌥⌘ | ⌃⌥
const AX_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
var axTrusted = false, globalMonitor = null, localMonitor = null;

function shortcutFor(ev) {
  if ((ev.modifierFlags & MOD_MASK) !== MOD_CTRL_OPT) return null;
  return SHORTCUTS[ev.keyCode] || null;
}

function checkTrust(prompt) {
  try {
    const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(!!prompt), 'AXTrustedCheckOptionPrompt');
    axTrusted = !!$.AXIsProcessTrustedWithOptions(opts);
  } catch (e) { log('accessibility check: ' + e); axTrusted = false; }
  return axTrusted;
}

// Install whatever the current trust allows. Safe to call again: it only adds what's missing.
function setupShortcuts() {
  if (!settings.shortcuts) return;
  // No local key monitor: a JXA block can't hand the event back, so it swallowed every key typed
  // into B-Side (the link box couldn't paste). While B-Side is in front, panel.html sends the
  // same ⌃⌥ shortcuts itself; the global monitor covers every other app.
  if (!checkTrust(!axPrompted && !axTrusted)) {
    if (!axPrompted) { axPrompted = true; saveState(); log('shortcuts: asked for Accessibility access'); }
    return;
  }
  if (!globalMonitor) {
    globalMonitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler($.NSEventMaskKeyDown, function (ev) {
      try { const name = shortcutFor(ev); if (name && !ev.isARepeat) command('hotkey:' + name); }
      catch (e) { log('global shortcut: ' + e); }
    });
    log('shortcuts: on');
  }
}

function removeShortcuts() {
  if (globalMonitor) { $.NSEvent.removeMonitor(globalMonitor); globalMonitor = null; }
  if (localMonitor) { $.NSEvent.removeMonitor(localMonitor); localMonitor = null; }
  log('shortcuts: off');
}

function hotkey(name) {
  log('shortcut ' + name);
  switch (name) {
    case 'chrome': {
      // Take the video open in Chrome, or send the wallpaper back to Chrome, or show the panel.
      const tab = frontChromeTab();
      if (tab) takeFromChrome(mode, tab);
      else if (on) backToChrome();
      else togglePanel(true);
      break;
    }
    case 'play': if (on) command('toggle'); break;
    case 'next': if (on) command('next'); break;
    case 'prev': if (on) command('prev'); break;
    case 'saver': if (on) setMode(mode === 'screensaver' ? 'wallpaper' : 'screensaver'); break;
    case 'mute': command('mute'); break;
  }
}

// ---------------------------------------------------------------- control panel

ObjC.registerSubclass({
  name: 'BSideController',
  methods: {
    'statusClick:': { types: ['void', ['id']], implementation: function () { togglePanel(); } },
    'notified:': { types: ['void', ['id']], implementation: function (n) { command(ObjC.unwrap(n.object)); } },
    'screensChanged:': { types: ['void', ['id']], implementation: function () { try { build(false); } catch (e) {} } },
    'locked:': { types: ['void', ['id']], implementation: function () { smartPause('lock', true); } },
    'unlocked:': { types: ['void', ['id']], implementation: function () { smartPause('lock', false); } },
    'tick:': { types: ['void', ['id']], implementation: function () { onTick(); } },
    'showPanel:': { types: ['void', ['id']], implementation: function () { togglePanel(true); } },
    'quitApp:': { types: ['void', ['id']], implementation: function () { command('quit'); } },
    'signinClosed:': { types: ['void', ['id']], implementation: function () {
      $.NSNotificationCenter.defaultCenter.removeObserverNameObject(ctrl, 'NSWindowWillCloseNotification', signinWin);
      checkSignedIn();

    } }
  }
});

ObjC.registerSubclass({
  name: 'BSidePanelHandler', protocols: ['WKScriptMessageHandler'],
  methods: {
    'userContentController:didReceiveScriptMessage:': { types: ['void', ['id', 'id']],
      implementation: function (uc, msg) { command(ObjC.unwrap(msg.body)); } }
  }
});

// ---------------------------------------------------------------- 'Use my YouTube account'

// Used once you sign in to YouTube from the panel. The main screen plays YouTube's normal watch page instead of the embed,
// so a signed-in YouTube Premium account plays without ads (the embed can't see the login:
// WebKit blocks it as a third-party cookie). A user script shows only the video and reports state.
ObjC.registerSubclass({
  name: 'BSidePlayerHandler', protocols: ['WKScriptMessageHandler'],
  methods: {
    'userContentController:didReceiveScriptMessage:': { types: ['void', ['id', 'id']],
      implementation: function (uc, msg) {
        const body = ObjC.unwrap(msg.body);
        if (body.indexOf('{"page"') === 0) log('account player: ' + body.slice(0, 200)); else mainState = body;
      } }
  }
});

function accountUrl(url) {
  const p = parseUrl(url || '');
  if (!p.id) return 'https://www.youtube.com/playlist?list=' + p.list;
  return watchUrl(p.id, p.list, p.t, -1);
}

function watchScript() {
  const cfg = { volume: settings.volume, muted: settings.muted, dim: settings.dim, fill: settings.fill };
  return `(function () {
if (window.top !== window) return;
var C = ${JSON.stringify(cfg)}, applied = false;
var css = 'html,body{background:#000!important;overflow:hidden!important}'
 + '#movie_player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;background:#000!important}'
 + '#movie_player .html5-video-container,#movie_player video.html5-main-video{position:fixed!important;width:100vw!important;height:100vh!important;left:0!important;top:0!important}'
 + '#movie_player video.html5-main-video{object-fit:contain!important}body.bs-fill #movie_player video.html5-main-video{object-fit:cover!important}'
 + '.ytp-chrome-top,.ytp-chrome-bottom,.ytp-gradient-top,.ytp-gradient-bottom,.ytp-ce-element,.ytp-pause-overlay,.ytp-paid-content-overlay,.ytp-cards-teaser,.ytp-iv-player-content,.ytp-caption-window-container,.ytp-spinner,.ytp-watermark,.ytp-endscreen-content,.ytp-autonav-endscreen,.iv-branding,.ytp-suggested-action,.ytp-overlays-container,.ytp-player-content{display:none!important}'
 + '#bs-dim{position:fixed;inset:0;background:#000;opacity:0;z-index:2147483647;pointer-events:none;transition:opacity .3s}*{cursor:none!important}';
function P() { var p = document.getElementById('movie_player'); return p && p.getPlayerState ? p : null; }
window.setLook = function (dim, fill) { C.dim = dim; C.fill = fill; var d = document.getElementById('bs-dim'); if (d) d.style.opacity = dim / 100; if (document.body) document.body.classList.toggle('bs-fill', !!fill); };
window.toggle = function () { var p = P(); if (!p) return; var st = p.getPlayerState(); st == 1 || st == 3 || st == -1 ? p.pauseVideo() : p.playVideo(); };
window.setVol = function (v) { C.volume = v; C.muted = false; var p = P(); if (p) { p.setVolume(v); p.unMute(); } };
window.setMuted = function (m) { C.muted = m; var p = P(); if (p) m ? p.mute() : p.unMute(); };
function setup() {
  if (!document.head || !document.body) return setTimeout(setup, 50);
  try { window.webkit.messageHandlers.bsideplayer.postMessage(JSON.stringify({ page: location.href.slice(0, 80) })); } catch (e) {}
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  var d = document.createElement('div'); d.id = 'bs-dim'; document.documentElement.appendChild(d);
  setLook(C.dim, C.fill);
}
setup();
setInterval(function () {
  var no = document.querySelector('ytd-consent-bump-v2-lightbox button[aria-label^="Reject"]');
  if (no) no.click();   // cookie consent: Reject all (essential cookies only), as if clicked
  var p = P(); if (!p) return;
  window.player = p;
  // Show only the player: on the path from <body> down to the player, hide every other element
  // and pin each container to the whole window. Re-checked each second, as YouTube re-renders.
  for (var child = p, el = p.parentElement; el && el !== document.documentElement; child = el, el = el.parentElement) {
    for (var k = 0; k < el.children.length; k++) {
      var sib = el.children[k];
      if (sib === child || sib.contains(p)) {   // never hide the player's own branch
        if (sib.dataset.bsHid) { delete sib.dataset.bsHid; sib.style.removeProperty('display'); }
        continue;
      }
      if (sib.dataset.bsHid || /^(STYLE|SCRIPT|LINK)$/.test(sib.tagName)) continue;
      sib.dataset.bsHid = '1';
      sib.style.setProperty('display', 'none', 'important');
    }
    if (el.dataset.bsHid) { delete el.dataset.bsHid; el.style.removeProperty('display'); }
    if (el.dataset.bsPin) continue;
    el.dataset.bsPin = '1';
    el.style.cssText += ';position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;contain:none!important;transform:none!important;filter:none!important;overflow:hidden!important;background:#000!important';
  }
  if (!applied) { applied = true; if (C.muted) p.mute(); else { p.unMute(); p.setVolume(C.volume); } p.playVideo(); }
  try { p.unloadModule('captions'); } catch (e) {}
  var ok = document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button');
  if (ok) ok.click();   // "Video paused. Continue watching?"
  try {
    var d = p.getVideoData();
    window.webkit.messageHandlers.bsideplayer.postMessage(JSON.stringify({ id: d.video_id, title: d.title, author: d.author,
      t: Math.floor(p.getCurrentTime()), d: Math.floor(p.getDuration()), s: p.getPlayerState(),
      i: p.getPlaylistIndex ? p.getPlaylistIndex() : -1, err: null, ad: !!document.querySelector('#movie_player.ad-showing') }));
  } catch (e) {}
}, 1000);
})();`;
}

// A window onto YouTube's sign-in, sharing the players' website data, so the login sticks.
function openSignin() {
  if (signinWin && signinWin.isVisible) { signinWin.makeKeyAndOrderFront(null); return; }
  const vf = $.NSScreen.screens.objectAtIndex(0).visibleFrame;
  const rect = $.NSMakeRect(vf.origin.x + (vf.size.width - 520) / 2, vf.origin.y + (vf.size.height - 720) / 2, 520, 720);
  signinWin = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, 1 | 2 | 8, $.NSBackingStoreBuffered, false);
  signinWin.releasedWhenClosed = false;
  signinWin.title = 'Sign in to YouTube';
  const web = $.WKWebView.alloc.initWithFrameConfiguration(signinWin.contentView.bounds, $.WKWebViewConfiguration.alloc.init);
  web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  web.customUserAgent = UA;
  signinWin.contentView.addSubview(web);
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(
    'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=' + encodeURIComponent('https://www.youtube.com/'))));
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(ctrl, 'signinClosed:', 'NSWindowWillCloseNotification', signinWin);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  signinWin.makeKeyAndOrderFront(null);
}

// Signed in when YouTube's login cookie is in the shared website data.
function checkSignedIn() {
  try {
    $.WKWebsiteDataStore.defaultDataStore.httpCookieStore.getAllCookies(function (cookies) {
      let found = false;
      for (let i = 0; i < cookies.count; i++) {
        const c = cookies.objectAtIndex(i);
        if (ObjC.unwrap(c.name) === 'LOGIN_INFO' && /youtube\.com$/.test(ObjC.unwrap(c.domain))) found = true;
      }
      if (found !== ytSignedIn) log('youtube account: ' + (found ? 'signed in' : 'signed out'));
      ytSignedIn = found;
      // Signed in means the watch-page player (Premium: no ads); signed out means the embed.
      if (on && found !== accountBuilt) { readMain(); if (main.id) current = watchUrl(main.id, parseUrl(current || '').list, main.t, main.i); build(true); }
    });
  } catch (e) { log('checkSignedIn: ' + e); }
}

function makePanel() {
  const vf = $.NSScreen.screens.objectAtIndex(0).visibleFrame;
  const w = 380, h = 700;
  const rect = $.NSMakeRect(vf.origin.x + vf.size.width - w - 16, vf.origin.y + vf.size.height - h - 8, w, h);
  // titled | closable | miniaturizable | fullSizeContentView
  panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect, 1 | 2 | 4 | 32768, $.NSBackingStoreBuffered, false);
  panel.releasedWhenClosed = false;
  panel.titlebarAppearsTransparent = true;
  panel.titleVisibility = 1;
  panel.movableByWindowBackground = true;
  panel.hidesOnDeactivate = false;
  panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary;
  panel.appearance = $.NSAppearance.appearanceNamed('NSAppearanceNameDarkAqua');
  panel.title = APP_NAME;

  const fx = $.NSVisualEffectView.alloc.initWithFrame(panel.contentView.bounds);
  fx.material = 13; fx.blendingMode = 0; fx.state = 1;
  fx.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  panel.contentView = fx;

  const cfg = $.WKWebViewConfiguration.alloc.init;
  panelHandler = $.BSidePanelHandler.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(panelHandler, 'bside');
  panelWeb = $.WKWebView.alloc.initWithFrameConfiguration(fx.bounds, cfg);
  panelWeb.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  panelWeb.setValueForKey($.NSNumber.numberWithBool(false), 'drawsBackground');
  fx.addSubview(panelWeb);

  const res = ObjC.unwrap($.NSBundle.mainBundle.resourcePath);
  const file = $.NSURL.fileURLWithPath(res + '/panel.html');
  panelWeb.loadFileURLAllowingReadAccessToURL(file, $.NSURL.fileURLWithPath(res));
}

function togglePanel(forceShow) {
  if (!panel) makePanel();
  if (panel.isVisible && !forceShow) { panel.orderOut(null); return; }
  if (mode === 'screensaver') setMode('wallpaper');
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  panel.makeKeyAndOrderFront(null);
  panel.makeFirstResponder(panelWeb);   // keys and Edit > Paste go to the panel page
  refreshChrome();
  pushPanel();
}

// Is Chrome making sound right now? macOS power assertions say so without asking Chrome.
var chromePlaying = false;
function chromeAudible() {
  if (!chromeRunning()) return false;
  try { return /Google Chrome.*Playing audio/.test(sa.doShellScript('pmset -g assertions')); } catch (e) { return false; }
}

function refreshChrome() {
  chromePlaying = !chromeJs && on ? chromeAudible() : false;
  const f = on ? null : findChromeTab();
  chromeTab = f ? { url: f.url, title: f.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '') } : null;
}

function panelState() {
  const p = parseUrl(current || '');
  const state = {
    on: on, mode: mode, error: (error && Date.now() - errorAt < 8000 ? error : null) || (on ? playerError : null), pausedBy: pausedBy, screens: $.NSScreen.screens.count,
    now: on ? { id: main.id || p.id, title: main.title || '', author: main.author || '', t: main.t || 0, d: main.d || 0,
                playing: main.s === 1, buffering: main.s === 3, list: !!p.list } : null,
    settings: settings, recents: recents, chrome: chromeTab, canResume: !!last,
    version: VERSION, players: views.length,
    followers: views.slice(1).map(function (v) { try { return JSON.parse(ObjC.unwrap(v.title)).id || null; } catch (e) { return null; } }),
    panelOpen: !!(panel && panel.isVisible),
    chromeJs: chromeJs || !chromePlaying,
    account: { signedIn: ytSignedIn, ad: !!(on && accountBuilt && main.ad) },
    shortcuts: { enabled: settings.shortcuts, trusted: axTrusted, global: !!globalMonitor, local: !!localMonitor }
  };
  return state;
}

function pushPanel() {
  if (!panel || !panel.isVisible || !panelWeb) return;
  const state = panelState();
  evalIn(panelWeb, 'window.render && render(' + JSON.stringify(state) + ')');
}

// ---------------------------------------------------------------- smart pause and timers

function smartPause(reason, pause) {
  if (!on) return;
  if (pause) {
    if (reason === 'lock' && !settings.pauseOnLock) return;
    if (reason === 'battery' && !settings.pauseOnBattery) return;
    if (main.s === 1 && !pausedBy) { pausedBy = reason; jsMain('player.pauseVideo()'); }
  } else if (pausedBy === reason) {
    pausedBy = null; jsMain('player.playVideo()');
  }
}

function idleSeconds() {
  try { return Number(sa.doShellScript("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'")); }
  catch (e) { return 0; }
}

function onBattery() {
  try { return /Battery Power/.test(sa.doShellScript('pmset -g ps | head -1')); } catch (e) { return false; }
}

function onTick() {
  try {
    tick++;
    if (on) { readMain(); syncFollowers(); skipStills(); }
    if (on && tick % 5 === 0 && settings.idleSaver > 0 && mode === 'wallpaper' && idleSeconds() >= settings.idleSaver * 60) setMode('screensaver');
    if (on && tick % 30 === 0 && (settings.pauseOnBattery || pausedBy === 'battery')) smartPause('battery', onBattery());
    if (tick % 30 === 0) checkSignedIn();
    if (settings.shortcuts && !globalMonitor && tick % 3 === 0) setupShortcuts();   // picks up the Allow click without a relaunch
    if (on && tick % 10 === 0 && main.id) { last = { url: watchUrl(main.id, parseUrl(current).list, main.t, main.i) }; saveState(); }
    if (panel && panel.isVisible) { if (tick % 3 === 0) refreshChrome(); pushPanel(); }
  } catch (e) { log('tick: ' + e); }
}

// ---------------------------------------------------------------- applet handlers

// Only one copy runs. A second launch (a double open, or another copy of the app on disk)
// shows the first copy's panel and quits, so commands never play twice.
function firstInstance() {
  const me = $.NSRunningApplication.currentApplication.processIdentifier;
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(BUNDLE_ID);
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if (a.processIdentifier < me && !a.terminated) return a;
  }
  return null;
}

// A normal app menu and Edit menu. The panel's text box needs Edit > Paste for ⌘V to work.
function buildMenu() {
  const bar = $.NSMenu.alloc.init;
  function sub(title, items) {
    const top = $.NSMenuItem.alloc.init;
    const menu = $.NSMenu.alloc.initWithTitle(title);
    items.forEach(function (it) {
      if (!it) { menu.addItem($.NSMenuItem.separatorItem); return; }
      const mi = menu.addItemWithTitleActionKeyEquivalent(it[0], it[1], it[2] || '');
      if (it[3]) mi.keyEquivalentModifierMask = it[3];
      if (it[4]) mi.target = it[4];
    });
    top.submenu = menu;
    bar.addItem(top);
  }
  sub(APP_NAME, [['Show Panel', 'showPanel:', ',', 0, ctrl], null, ['Hide ' + APP_NAME, 'hide:', 'h'], null, ['Quit ' + APP_NAME, 'quitApp:', 'q', 0, ctrl]]);
  sub('Edit', [['Undo', 'undo:', 'z'], ['Redo', 'redo:', 'Z'], null, ['Cut', 'cut:', 'x'], ['Copy', 'copy:', 'c'], ['Paste', 'paste:', 'v'], ['Select All', 'selectAll:', 'a']]);
  $.NSApplication.sharedApplication.mainMenu = bar;
}

function run() {
  const app = $.NSApplication.sharedApplication;
  const first = firstInstance();
  if (first) {
    log('already running as ' + first.processIdentifier + ', showing its panel');
    $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('bside.cmd', 'panel', $(), true);
    first.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    app.terminate(null);
    return;
  }
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);   // Dock icon while running; clicking it shows the panel
  loadState();
  ctrl = $.BSideController.alloc.init;
  buildMenu();
  checkSignedIn();

  item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  item.autosaveName = 'BSide';
  item.button.title = '♫';
  item.button.toolTip = APP_NAME;
  item.button.target = ctrl;
  item.button.action = 'statusClick:';

  $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(ctrl, 'notified:', 'bside.cmd', $());
  $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(ctrl, 'locked:', 'com.apple.screenIsLocked', $());
  $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(ctrl, 'unlocked:', 'com.apple.screenIsUnlocked', $());
  const wsnc = $.NSWorkspace.sharedWorkspace.notificationCenter;
  wsnc.addObserverSelectorNameObject(ctrl, 'locked:', 'NSWorkspaceScreensDidSleepNotification', $());
  wsnc.addObserverSelectorNameObject(ctrl, 'unlocked:', 'NSWorkspaceScreensDidWakeNotification', $());
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(ctrl, 'screensChanged:', 'NSApplicationDidChangeScreenParametersNotification', $());
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, ctrl, 'tick:', $(), true);
  setupShortcuts();

  if (settings.resumeOnLaunch && last) start(last.url, 'wallpaper');
  else togglePanel(true);
}

// Opening the app again while it runs shows the panel.
function reopen() { togglePanel(true); }

function idle() { return 60; }
