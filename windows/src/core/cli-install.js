'use strict';
// Puts the `bside` command on the PATH by copying bside.cmd into a folder that is already on it
// (%LOCALAPPDATA%\Microsoft\WindowsApps). The copy carries the absolute path of the installed exe.
const nodeFs = require('fs');
const path = require('path');

const MARKER = 'rem bside: drive B-Side';
const EXE_LINE = /^set "EXE_ABS=.*"\s*$/m;

function toCrlf(text) { return text.replace(/\r?\n/g, '\r\n'); }

// The shim text with the exe path filled in. Batch files need CRLF line endings.
function shimWithExe(template, exePath) {
  if (!EXE_LINE.test(template)) throw new Error('shim has no EXE_ABS line');
  return toCrlf(template.replace(EXE_LINE, function () { return 'set "EXE_ABS=' + exePath + '"'; }));
}

// opts: { fs, src (path to bside.cmd), destDir, exePath }. Returns { ok, action, dest, detail }.
function installShim(opts) {
  const fs = opts.fs || nodeFs;
  const dest = path.join(opts.destDir, 'bside.cmd');
  try {
    const want = shimWithExe(String(fs.readFileSync(opts.src, 'utf8')), opts.exePath);
    let have = null;
    try { have = String(fs.readFileSync(dest, 'utf8')); } catch (e) { /* not there yet */ }
    if (have === want) return { ok: true, action: 'unchanged', dest: dest };
    if (have !== null && have.indexOf(MARKER) < 0) return { ok: false, action: 'skipped', dest: dest, detail: 'a different bside.cmd is already there' };
    fs.mkdirSync(opts.destDir, { recursive: true });
    fs.writeFileSync(dest, want);
    return { ok: true, action: have === null ? 'installed' : 'updated', dest: dest };
  } catch (e) {
    return { ok: false, action: 'failed', dest: dest, detail: String(e && e.message || e) };
  }
}

// Removes our copy, and only ours.
function removeShim(opts) {
  const fs = opts.fs || nodeFs;
  const dest = path.join(opts.destDir, 'bside.cmd');
  try {
    const have = String(fs.readFileSync(dest, 'utf8'));
    if (have.indexOf(MARKER) < 0) return { ok: false, action: 'skipped', dest: dest };
    fs.unlinkSync(dest);
    return { ok: true, action: 'removed', dest: dest };
  } catch (e) {
    return { ok: true, action: 'none', dest: dest };
  }
}

module.exports = { MARKER, shimWithExe, installShim, removeShim, toCrlf };
