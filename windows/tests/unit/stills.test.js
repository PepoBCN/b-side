'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleBitmap, frameDiff, scoreFrames, StillGuard, STILL_MAX, STILL_DIFF } = require('../../src/core/stills');

// A w x h BGRA bitmap filled by fn(x, y) -> brightness 0..255.
function bitmap(w, h, fn) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y), i = (y * w + x) * 4;
    b[i] = v; b[i + 1] = v; b[i + 2] = v; b[i + 3] = 255;
  }
  return b;
}

test('sampleBitmap gives a 16 x 12 grid of brightness', () => {
  const g = sampleBitmap(bitmap(320, 180, () => 100), 320, 180);
  assert.equal(g.length, 192);
  assert.ok(g.every((v) => v === 100));
});

test('brightness is the strongest channel, whatever the colour order', () => {
  const b = Buffer.from([10, 200, 30, 255]);
  const big = Buffer.concat(Array(320 * 180).fill(b));
  assert.equal(sampleBitmap(big, 320, 180)[0], 200);
});

test('sampleBitmap rejects empty input', () => {
  assert.equal(sampleBitmap(null, 10, 10), null);
  assert.equal(sampleBitmap(Buffer.alloc(0), 10, 10), null);
});

test('a still picture scores near zero and a moving video scores high', () => {
  const still = sampleBitmap(bitmap(160, 120, (x, y) => (x + y) % 255), 160, 120);
  const same = [still, still.slice(), still.slice()];
  assert.ok(scoreFrames(same) < 5);
  const f1 = sampleBitmap(bitmap(160, 120, (x) => x), 160, 120);
  const f2 = sampleBitmap(bitmap(160, 120, (x, y) => y * 2), 160, 120);
  const f3 = sampleBitmap(bitmap(160, 120, () => 220), 160, 120);
  assert.ok(scoreFrames([f1, f2, f3]) > 50);
});

test('frameDiff is the mean absolute difference', () => {
  assert.equal(frameDiff([0, 0, 10, 10], [10, 10, 10, 10]), 5);
});

test('scoreFrames needs all three frames', () => {
  assert.equal(scoreFrames([[1], null, [1]]), null);
  assert.equal(scoreFrames(null), null);
});

// A guard with scripted frames: ids ending in "S" are stills.
function guard(opts) {
  const skipped = [], logs = [];
  const still = [10, 10, 10];
  const g = new StillGuard({
    loadFrames: async (id) => id.endsWith('S') ? [still, still, still] : [Array(5).fill(0), Array(5).fill(100), Array(5).fill(200)],
    skip: () => skipped.push(1),
    log: (m) => logs.push(m)
  });
  return { g, skipped, logs };
}
const settings = { skipStill: true };
const flush = () => new Promise((r) => setImmediate(r));

test('skips a still track in a playlist and logs it', async () => {
  const { g, skipped, logs } = guard();
  const main = { id: 'aaaaaaaaaaS', title: 'Audio only', author: 'Someone' };
  g.tick(main, true, settings);
  await flush();
  assert.equal(skipped.length, 1);
  assert.match(logs[0], /^skipping still track aaaaaaaaaaS Audio only$/);
});

test('leaves a moving video alone and resets the run', async () => {
  const { g, skipped } = guard();
  g.tick({ id: 'bbbbbbbbbbb', title: 'Video', author: 'x' }, true, settings);
  await flush();
  assert.equal(skipped.length, 0);
  assert.equal(g.run, 0);
});

test('never checks outside a playlist, or when the setting is off', async () => {
  const { g, skipped } = guard();
  g.tick({ id: 'aaaaaaaaaaS' }, false, settings);
  g.tick({ id: 'aaaaaaaaaaS' }, true, { skipStill: false });
  await flush();
  assert.equal(skipped.length, 0);
});

test('"Topic" channels count as stills without a download', () => {
  const { g, skipped } = guard();
  g.tick({ id: 'cccccccccc1', title: 't', author: 'Artist - Topic' }, true, settings);
  assert.equal(skipped.length, 1);
});

test('skips at most ' + STILL_MAX + ' in a row, so an all-stills mix still plays', async () => {
  const { g, skipped } = guard();
  for (let i = 0; i < 6; i++) {
    g.tick({ id: 'track00000' + i, title: 't', author: 'A - Topic' }, true, settings);
  }
  assert.equal(skipped.length, STILL_MAX);
  assert.equal(g.run, STILL_MAX);
});

test('a slow check about an old track is dropped when the track has changed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const skipped = [];
  const g = new StillGuard({
    loadFrames: async () => { await gate; return [[1], [1], [1]]; },
    skip: () => skipped.push(1), log: () => {}
  });
  g.tick({ id: 'aaaaaaaaaaa' }, true, settings);
  g.latest = { id: 'zzzzzzzzzzz' };
  release();
  await flush(); await flush();
  assert.equal(skipped.length, 0);
  assert.equal(g.checked, null);
  assert.equal(g.cache['aaaaaaaaaaa'], true);
});

test('threshold is ' + STILL_DIFF, () => {
  assert.equal(STILL_DIFF, 10);
});
