'use strict';
// Global shortcuts, Ctrl+Alt + key. globalShortcut comes from Electron (RegisterHotKey on Windows).

const KEYS = [
  ['Ctrl+Alt+B', 'browser'],   // play the clipboard link, or back to the browser, or show the panel
  ['Ctrl+Alt+P', 'play'],
  ['Ctrl+Alt+Left', 'prev'],
  ['Ctrl+Alt+Right', 'next'],
  ['Ctrl+Alt+S', 'saver'],
  ['Ctrl+Alt+M', 'mute']
];

function createShortcuts(globalShortcut, onKey, log) {
  log = log || function () {};
  let registered = [], failed = [], active = false;

  function tryRegister(acc, name) {
    try {
      const ok = globalShortcut.register(acc, function () { try { onKey(name); } catch (e) { log('shortcut ' + name + ': ' + e); } });
      return ok !== false && (typeof globalShortcut.isRegistered !== 'function' || globalShortcut.isRegistered(acc));
    } catch (e) { log('shortcut ' + acc + ': ' + e); return false; }
  }

  function enable() {
    active = true;
    registered = []; failed = [];
    KEYS.forEach(function (k) { (tryRegister(k[0], k[1]) ? registered : failed).push(k[0]); });
    log('shortcuts: on, registered ' + registered.length + ', failed ' + failed.length + (failed.length ? ' (' + failed.join(', ') + ')' : ''));
  }

  function disable() {
    active = false;
    KEYS.forEach(function (k) { try { globalShortcut.unregister(k[0]); } catch (e) { /* ignore */ } });
    registered = []; failed = [];
    log('shortcuts: off');
  }

  // Another program may release a key later. Try the failed ones again.
  function retryFailed() {
    if (!active || !failed.length) return;
    const again = failed.slice(); failed = [];
    again.forEach(function (acc) {
      const k = KEYS.find(function (x) { return x[0] === acc; });
      (tryRegister(acc, k[1]) ? registered : failed).push(acc);
    });
  }

  return {
    enable: enable, disable: disable, retryFailed: retryFailed,
    info: function (enabledSetting) { return { enabled: !!enabledSetting, registered: registered.slice(), failed: failed.slice() }; }
  };
}

module.exports = { KEYS, createShortcuts };
