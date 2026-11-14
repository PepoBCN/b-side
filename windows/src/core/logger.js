'use strict';
const fs = require('fs');
const path = require('path');

// Appends "ISO-time message" lines to a log file. Never throws.
function createLogger(file) {
  let ready = false;
  return function log(msg) {
    try {
      if (!ready) { fs.mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
      fs.appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { /* logging must never break the app */ }
  };
}

module.exports = { createLogger };
