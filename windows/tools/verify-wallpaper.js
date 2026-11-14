'use strict';
// Diagnostics for the Win32 wallpaper attach (lane B). Run it as an Electron main script:
//
//   npx electron tools/verify-wallpaper.js --out wallpaper-tree.json --shot wallpaper.png
//
// It opens a solid magenta test window, attaches it behind the desktop icons, dumps the shell window tree
// (Progman, every WorkerW, SHELLDLL_DefView, SysListView32, our window: class, rect, style bits, parent) as JSON
// to stdout and to --out, takes a screenshot of the primary display to --shot and counts how much of it is magenta.
//
// Exit codes: 0 attached (method workerw or progman-child, or bottom with a WARN, or not Windows),
//             2 method none, 3 parent class is not WorkerW/Progman, 4 koffi/Win32 layer unavailable on Windows,
//             5 --require-visible was given and the test colour is not visible in the screenshot, 9 crashed.
// Flags: --out FILE, --shot FILE, --settle MS (default 2000), --require-visible, --no-gpu.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, screen, desktopCapturer } = require('electron');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : def;
};
const outFile = opt('--out', null);
const shotFile = opt('--shot', null);
const settleMs = Number(opt('--settle', 2000));
const requireVisible = flag('--require-visible');

const step = (msg) => console.log(`[verify-wallpaper] ${new Date().toISOString()} ${msg}`);
const report = { tool: 'verify-wallpaper', startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, steps: [] };
const note = (msg) => {
  report.steps.push(msg);
  step(msg);
};

// Same flags the app should use: keep Chromium from pausing a window that Windows considers covered.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (flag('--no-gpu')) app.disableHardwareAcceleration();

function finish(code) {
  report.exitCode = code;
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2);
  console.log('[verify-wallpaper] ---- RESULT JSON BEGIN ----');
  console.log(json);
  console.log('[verify-wallpaper] ---- RESULT JSON END ----');
  if (outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, json);
      step('wrote ' + outFile);
    } catch (e) {
      step('could not write --out: ' + e.message);
    }
  }
  step(`exit ${code}`);
  app.exit(code);
}

/** Share of pixels close to the test colour in a BGRA bitmap, sampled on a grid. */
function magentaRatio(image) {
  const size = image.getSize();
  const bmp = image.toBitmap(); // BGRA on Windows
  if (!size.width || !size.height || bmp.length < size.width * size.height * 4) return { ratio: 0, sampled: 0, size };
  let hit = 0;
  let total = 0;
  const stepPx = Math.max(1, Math.floor(Math.min(size.width, size.height) / 120));
  for (let y = 0; y < size.height; y += stepPx) {
    for (let x = 0; x < size.width; x += stepPx) {
      const o = (y * size.width + x) * 4;
      const b = bmp[o];
      const g = bmp[o + 1];
      const r = bmp[o + 2];
      total++;
      if (r > 200 && g < 60 && b > 200) hit++;
    }
  }
  return { ratio: total ? hit / total : 0, sampled: total, size };
}

async function main() {
  note(`electron ${process.versions.electron}, node ${process.versions.node}, platform ${process.platform}, os ${os.release()}`);
  const wallpaper = require('../src/win/wallpaper.js');
  report.supported = wallpaper.supported();
  note('wallpaper.supported() = ' + report.supported);

  if (process.platform !== 'win32') {
    report.note = 'Not Windows: nothing to attach. This only proves the module loads and the tool runs.';
    report.attach = wallpaper.attach(null, { x: 0, y: 0, width: 1, height: 1 });
    note('attach stub returned ' + JSON.stringify(report.attach));
    note('supported:false');
    return finish(0);
  }
  if (!report.supported) {
    note('FAIL: the Win32 layer did not load (koffi missing or broken)');
    return finish(4);
  }

  const display = screen.getPrimaryDisplay();
  report.displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === display.id }));
  note('displays: ' + JSON.stringify(report.displays));

  report.before = wallpaper.inspect();
  note('shell before attach: layout=' + report.before.layout + ' build=' + report.before.build + ' progmanExStyle=' + report.before.progmanExStyle);

  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: process.env.BSIDE_TRANSPARENT === '1' ? undefined : '#ff00ff',
    transparent: process.env.BSIDE_TRANSPARENT === '1',
    webPreferences: { backgroundThrottling: false },
  });
  const html = '<body style="margin:0;background:#ff00ff"><div style="position:fixed;inset:0;background:#ff00ff"></div>' +
    '<script>setInterval(()=>{document.title=String(Date.now())},500)</script></body>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.showInactive();
  note('test window created and shown');

  const result = wallpaper.attach(win, display.bounds);
  report.attach = result;
  note('attach -> ' + JSON.stringify(result));

  await new Promise((r) => setTimeout(r, settleMs));

  report.describe = wallpaper.describe(win);
  note('describe -> ' + JSON.stringify(report.describe));
  report.after = wallpaper.inspect();
  report.tree = wallpaper.dumpTree([win]);
  note('window tree dumped: ' + (report.tree.shell || []).length + ' shell roots');

  // Screenshot of the primary display (physical pixels).
  try {
    const px = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: px });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (src && !src.thumbnail.isEmpty()) {
      if (shotFile) {
        fs.mkdirSync(path.dirname(path.resolve(shotFile)), { recursive: true });
        fs.writeFileSync(shotFile, src.thumbnail.toPNG());
        note('screenshot written to ' + shotFile);
      }
      const m = magentaRatio(src.thumbnail);
      report.screenshot = { file: shotFile || null, size: m.size, magentaRatio: Number(m.ratio.toFixed(4)), sampled: m.sampled };
      note(`magenta ratio in screenshot: ${(m.ratio * 100).toFixed(1)}% (${m.sampled} samples)`);
      report.visibleInScreenshot = m.ratio > 0.5;
      if (!report.visibleInScreenshot) {
        note('WARN: the test colour is not visible in the screenshot. Parent class alone cannot prove the wallpaper renders; on a runner without a real shell desktopCapturer may also return a black frame.');
      }
    } else {
      note('WARN: desktopCapturer returned no usable screen source');
      report.screenshot = { error: 'no source' };
    }
  } catch (e) {
    note('WARN: screenshot failed: ' + e.message);
    report.screenshot = { error: e.message };
  }

  const okClass = ['WorkerW', 'Progman'].includes(result.parentClass);
  let code = 0;
  if (result.method === 'none') {
    note('FAIL: method none, nothing attached');
    code = 2;
  } else if (result.method === 'bottom') {
    note('WARN: method is "bottom" (fallback). The window is only bottom-most, not embedded in the desktop.');
  } else if (!okClass) {
    note(`FAIL: parent class "${result.parentClass}" is not WorkerW or Progman`);
    code = 3;
  } else {
    note(`OK: method ${result.method}, parent class ${result.parentClass}`);
  }
  if (code === 0 && requireVisible && report.visibleInScreenshot !== true) {
    note('FAIL: --require-visible given and the test colour is not visible');
    code = 5;
  }

  wallpaper.detach(win);
  note('detached');
  try {
    win.destroy();
  } catch (_) {
    /* ignore */
  }
  finish(code);
}

app.whenReady().then(main).catch((e) => {
  console.error('[verify-wallpaper] crashed:', e && e.stack ? e.stack : e);
  report.crash = String(e && e.stack ? e.stack : e);
  finish(9);
});
// Never hang CI: hard stop after 90 s.
setTimeout(() => {
  step('timeout after 90 s');
  report.timeout = true;
  finish(9);
}, 90000).unref();
