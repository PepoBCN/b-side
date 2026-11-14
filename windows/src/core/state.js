'use strict';
// Settings, recents and the last video, saved as JSON in the user data folder.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./safe-write');

const DEFAULTS = {
  volume: 80, muted: false, dim: 0, fill: true, screens: 'all',
  pauseOnLock: true, pauseOnBattery: false, idleSaver: 0,
  resumeOnLaunch: false, launchAtLogin: false, skipStill: true, shortcuts: true,
  cli: true,                  // put the `bside` command on the PATH (installed app only)
  wallpaperTransparent: false // transparent player windows, in case Windows 11 24H2 draws nothing otherwise
};
const RECENTS_MAX = 8;

// Same rule as the Mac: booleans accept true, 'true' or 'on'; numbers clamp to 0..100.
function coerce(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return undefined;
  const d = DEFAULTS[key];
  if (typeof d === 'boolean') return value === true || value === 'true' || value === 'on';
  if (typeof d === 'number') return Math.max(0, Math.min(100, Number(value) || 0));
  const s = String(value);
  return key === 'screens' ? (s === 'main' ? 'main' : 'all') : s;
}

function cleanRecents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(function (r) { return r && typeof r.id === 'string' && typeof r.title === 'string'; })
    .map(function (r) { return { id: r.id, list: r.list || null, title: r.title }; })
    .slice(0, RECENTS_MAX);
}

class Store {
  constructor(dir, fsImpl) {
    this.dir = dir;
    this.fs = fsImpl || fs;
    this.file = path.join(dir, 'state.json');
    this.settings = Object.assign({}, DEFAULTS);
    this.recents = [];
    this.last = null;
  }

  load() {
    try {
      const s = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      const merged = Object.assign({}, DEFAULTS);
      Object.keys(s.settings || {}).forEach((k) => {
        const v = coerce(k, s.settings[k]);
        if (v !== undefined) merged[k] = v;
      });
      this.settings = merged;
      this.recents = cleanRecents(s.recents);
      this.last = s.last && typeof s.last.url === 'string' ? { url: s.last.url } : null;
    } catch (e) { /* first run or a damaged file: keep the defaults */ }
    return this;
  }

  save() {
    try {
      writeAtomic(this.file, JSON.stringify({ settings: this.settings, recents: this.recents, last: this.last }, null, 1), { fs: this.fs });
      return true;
    } catch (e) { return false; }
  }

  // Returns the stored value, or undefined for an unknown key.
  set(key, value) {
    const v = coerce(key, value);
    if (v === undefined) return undefined;
    this.settings[key] = v;
    return v;
  }

  // Newest first, at most RECENTS_MAX. Returns true when the list changed.
  rememberRecent(id, list, title) {
    const key = list || id;
    const top = this.recents[0];
    if (top && (top.list || top.id) === key && top.title === title) return false;
    this.recents = this.recents.filter(function (r) { return (r.list || r.id) !== key && r.id !== id; });
    this.recents.unshift({ id: id, list: list || null, title: title });
    this.recents = this.recents.slice(0, RECENTS_MAX);
    return true;
  }

  forgetRecents() { this.recents = []; }
}

module.exports = { DEFAULTS, RECENTS_MAX, coerce, cleanRecents, Store };
