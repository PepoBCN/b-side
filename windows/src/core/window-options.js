'use strict';
// Plain data for the Electron windows, kept apart from main.js so it can be tested.

function playerWindowOptions(o) {
  const opts = {
    x: o.rect.x, y: o.rect.y, width: o.rect.width, height: o.rect.height,
    frame: false, show: false, skipTaskbar: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false,
    title: 'B-Side player',
    webPreferences: {
      session: o.session, preload: o.preload,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  };
  // A transparent window is layered from the start, which may be what Windows 11 24H2 needs to
  // draw a window inside the desktop. The page paints its own black background (see player-page.js).
  if (o.transparent) opts.transparent = true; else opts.backgroundColor = '#000000';
  return opts;
}

const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };

// Where the control panel goes: top right of the work area, 380 wide, 400 to 700 high.
function panelBounds(workArea) {
  const wa = workArea && workArea.width > 0 && workArea.height > 0 ? workArea : FALLBACK_WORK_AREA;
  const w = 380;
  const h = Math.max(400, Math.min(700, wa.height - 16));
  return { x: wa.x + Math.max(0, wa.width - w - 16), y: wa.y + 8, width: w, height: h };
}

module.exports = { playerWindowOptions, panelBounds, FALLBACK_WORK_AREA };
