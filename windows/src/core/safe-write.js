'use strict';
// Write a file so a reader never sees half of it: write a temp file, then rename over the target.
// On Windows the rename fails with EPERM or EBUSY while antivirus or another reader has the file
// open. Retry once, then fall back to writing the target directly and delete the temp file.
const nodeFs = require('fs');
const path = require('path');

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait available */ }
}

// Returns 'rename' or 'direct' for how the write landed. Throws only if the direct write fails too.
function writeAtomic(file, data, opts) {
  opts = opts || {};
  const fs = opts.fs || nodeFs;
  const sleep = opts.sleep || sleepSync;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
    return 'rename';
  } catch (e) {
    if (e && RETRY_CODES.indexOf(e.code) >= 0) {
      sleep(50);
      try { fs.renameSync(tmp, file); return 'rename'; } catch (e2) { /* fall through to a direct write */ }
    }
  }
  try {
    fs.writeFileSync(file, data);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e3) { /* already gone */ }
  }
  return 'direct';
}

module.exports = { writeAtomic, RETRY_CODES };
