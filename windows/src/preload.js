'use strict';
// Runs in the control panel and in each player page (the main frame only). Sandboxed, so
// it can use nothing but electron's renderer modules.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bside', {
  // Panel to app: a command such as "toggle" or "url:https://...".
  send: function (cmd) { ipcRenderer.send('bside:cmd', String(cmd)); },
  // App to panel: the state, pushed about once a second while the panel is open.
  onRender: function (cb) {
    ipcRenderer.on('bside:render', function (e, state) { try { cb(state); } catch (err) { /* keep listening */ } });
    ipcRenderer.send('bside:ready');
  }
});

// Player page to app, used by screensaver mode to end on a click, a key or a deliberate mouse move.
contextBridge.exposeInMainWorld('bsideInput', {
  send: function (kind, px) { ipcRenderer.send('bside:input', String(kind), Number(px) || 0); }
});
