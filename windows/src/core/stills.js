'use strict';
// Still-picture tracks. Mixes are full of audio uploads with one still picture. YouTube's three
// automatic thumbnails (1.jpg, 2.jpg, 3.jpg) come from about a quarter, half and three quarters
// through a video: if they barely differ, the video is a still. Moving videos score 50 and up,
// stills under 5.

const STILL_MAX = 3;     // skip at most this many in a row, so an all-stills mix still plays
const STILL_DIFF = 10;
const GRID_W = 16, GRID_H = 12;

// Brightness on a 16 x 12 grid. `bitmap` is 4 bytes a pixel (BGRA or RGBA, the colour order
// does not matter because brightness is the strongest of the three colour channels, as on the Mac).
function sampleBitmap(bitmap, width, height) {
  if (!bitmap || !bitmap.length || !width || !height) return null;
  const out = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = Math.floor((x + 0.5) * width / GRID_W);
      const py = Math.floor((y + 0.5) * height / GRID_H);
      const i = (py * width + px) * 4;
      out.push(Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]));
    }
  }
  return out;
}

function frameDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// Largest difference between any two of the three frames, or null when a frame is missing.
function scoreFrames(f) {
  if (!f || !f[0] || !f[1] || !f[2]) return null;
  return Math.max(frameDiff(f[0], f[1]), frameDiff(f[1], f[2]), frameDiff(f[0], f[2]));
}

// Fetches and decodes the three thumbnails. net and nativeImage come from Electron.
function createFrameLoader(net, nativeImage) {
  return async function loadFrames(id) {
    const frames = [];
    for (const n of [1, 2, 3]) {
      try {
        const res = await net.fetch('https://i.ytimg.com/vi/' + id + '/' + n + '.jpg');
        if (!res.ok) { frames.push(null); continue; }
        const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
        if (img.isEmpty()) { frames.push(null); continue; }
        const size = img.getSize();
        frames.push(sampleBitmap(img.toBitmap(), size.width, size.height));
      } catch (e) { frames.push(null); }
    }
    return frames;
  };
}

class StillGuard {
  // deps: { loadFrames(id) -> Promise<frames>, skip(), log(msg) }
  constructor(deps) {
    this.deps = deps;
    this.cache = {};
    this.checked = null;
    this.run = 0;
    this.job = null;
  }

  reset() { this.checked = null; this.run = 0; }

  // True when this mix has hit the skip limit and the current track is still a still.
  mixIsStill(id) { return this.run >= STILL_MAX && !!this.cache[id]; }

  // Called once a second with the main player's state. current is the link being played.
  tick(main, hasList, settings) {
    this.latest = main;
    if (!settings.skipStill || !main.id || !hasList) return;
    if (this.job) return;
    if (main.id === this.checked) return;
    const topic = / - Topic$/.test(main.author || '');
    if (main.id in this.cache || topic) {
      this.checked = main.id;
      this.decide(main, this.cache[main.id] || topic);
      return;
    }
    const id = main.id;
    this.job = { id: id };
    Promise.resolve().then(() => this.deps.loadFrames(id)).then((frames) => {
      const score = scoreFrames(frames);
      this.job = null;
      this.cache[id] = score !== null && score < STILL_DIFF;
      if (!this.latest || this.latest.id !== id) return;   // the track changed while we looked; check the new one next tick
      this.checked = id;
      this.decide(this.latest, this.cache[id]);
    }).catch((e) => {
      this.job = null;
      this.deps.log('still check ' + id + ': ' + e);
    });
  }

  decide(main, still) {
    if (!still) { this.run = 0; return; }
    if (this.run >= STILL_MAX) return;
    this.run++;
    this.deps.log('skipping still track ' + main.id + ' ' + (main.title || ''));
    this.deps.skip();
  }
}

module.exports = { STILL_MAX, STILL_DIFF, sampleBitmap, frameDiff, scoreFrames, createFrameLoader, StillGuard };
