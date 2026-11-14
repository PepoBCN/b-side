'use strict';
// One entry point for the panel, the tray, the shortcuts and the `bside` CLI.
// Commands are "name" or "name:value", with the same names as the Mac app.
//
// The engine is whatever implements playback. See main.js, and tests/unit/commands.test.js for a fake.

function createRouter(engine, log) {
  log = log || function () {};

  function command(raw) {
    try {
      const c = String(raw == null ? '' : raw);
      const i = c.indexOf(':');
      const name = i < 0 ? c : c.slice(0, i);
      const arg = i < 0 ? '' : c.slice(i + 1);
      switch (name) {
        case 'toggle': case 'pause': engine.toggle(); break;
        case 'play': engine.play(); break;
        case 'next': engine.next(); break;
        case 'prev': engine.prev(); break;
        case 'seek': engine.seek(Number(arg)); break;
        case 'mute': engine.setSetting('muted', !engine.settings().muted); break;
        case 'louder': engine.setSetting('volume', engine.settings().volume + 10); break;
        case 'quieter': engine.setSetting('volume', engine.settings().volume - 10); break;
        case 'vol': engine.setSetting('volume', arg); break;
        case 'screensaver': case 'wallpaper':
          if (engine.isOn()) engine.setMode(name); else if (engine.canResume()) engine.start(engine.lastUrl(), name);
          break;
        case 'mode': command(arg); break;
        case 'on': case 'chrome': engine.playClipboard(arg || engine.mode()); break;
        case 'url': engine.start(arg, engine.mode()); break;
        case 'pasteclip': engine.playClipboard(engine.mode()); break;
        case 'resume': if (engine.canResume()) engine.start(engine.lastUrl(), 'wallpaper'); break;
        case 'recent': engine.recent(Number(arg)); break;
        case 'forget': engine.forget(); break;
        case 'tochrome': case 'off': engine.backToBrowser(); break;
        case 'stop': engine.stop(); break;
        case 'set': { const j = arg.indexOf('='); if (j > 0) engine.setSetting(arg.slice(0, j), arg.slice(j + 1)); break; }
        case 'panel': engine.showPanel(); break;
        case 'hidepanel': engine.hidePanel(); break;
        case 'hotkey': engine.hotkey(arg); break;
        case 'status': engine.writeStatus(); break;
        case 'quit': engine.quit(); break;
        default: break;
      }
    } catch (e) {
      log('command ' + raw + ': ' + (e && e.stack ? e.stack : e));
      try { engine.setError('Something went wrong: ' + e); } catch (e2) { /* ignore */ }
    }
    try { engine.pushPanel(); } catch (e) { /* the panel may be closed */ }
  }

  return command;
}

// The app folder or script that `electron .` puts in argv in development.
function looksLikeAppPath(a) {
  if (a === '.' || /\.asar$/i.test(a) || /main\.js$/i.test(a)) return true;
  try { return require('fs').statSync(a).isDirectory(); } catch (e) { return false; }
}

// Pull the command out of a process argv, plus the test hook --user-data-dir=<dir>.
// Chromium reads "--cmd" as a switch with no value and, in a second launch's argv, moves every
// switch to the front and every loose word to the back (and adds some of its own). So the form
// "--cmd=value" is exact, and for "--cmd value" the value is the loose words left once the app
// path is taken out.
function parseArgv(argv, isAppPath) {
  isAppPath = isAppPath || looksLikeAppPath;
  const out = { cmd: null, userDataDir: null };
  let bare = false;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--cmd') bare = true;
    else if (a.startsWith('--cmd=')) out.cmd = a.slice(6);
    else if (a.startsWith('--user-data-dir=')) out.userDataDir = a.slice(16);
    else if (i > 0 && !a.startsWith('-')) words.push(a);
  }
  if (out.cmd === null && bare) out.cmd = words.filter(function (w) { return !isAppPath(w); }).join(' ');
  if (out.cmd !== null) out.cmd = out.cmd.trim().replace(/^"(.*)"$/, '$1').trim();
  return out;
}

// A link typed after the bare command word, as in `bside https://youtu.be/...`, or a CLI word
// from the Mac help text that maps onto a command (vol 50, dim 30, screens main, fill off).
function normaliseCli(text) {
  const t = String(text || '').trim();
  if (!t) return 'panel';
  if (/^https?:\/\//i.test(t)) return 'url:' + t;
  const m = t.match(/^(vol|dim|screens|fill)\s+(\S+)$/i);
  if (m) {
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'vol') return 'vol:' + v;
    if (k === 'fill') return 'set:fill=' + (v === 'off' ? 'false' : 'true');
    return 'set:' + k + '=' + v;
  }
  const w = t.match(/^on\s+(\S+)$/i);
  if (w) return 'on:' + w[1];
  return t;
}

module.exports = { createRouter, parseArgv, normaliseCli };
