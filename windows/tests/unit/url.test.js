'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUrl, watchUrl } = require('../../src/core/url');

test('parses watch, short, embed, shorts and live links', () => {
  const id = '_JZom_gVfuw';
  assert.equal(parseUrl('https://www.youtube.com/watch?v=' + id).id, id);
  assert.equal(parseUrl('https://youtu.be/' + id).id, id);
  assert.equal(parseUrl('https://www.youtube.com/embed/' + id).id, id);
  assert.equal(parseUrl('https://www.youtube.com/shorts/' + id).id, id);
  assert.equal(parseUrl('https://www.youtube.com/live/' + id).id, id);
});

test('playlist links with and without a video', () => {
  const a = parseUrl('https://www.youtube.com/watch?v=_JZom_gVfuw&list=RDabc123_-x');
  assert.deepEqual(a, { id: '_JZom_gVfuw', list: 'RDabc123_-x', t: 0 });
  const b = parseUrl('https://www.youtube.com/playlist?list=PLabc123');
  assert.deepEqual(b, { id: null, list: 'PLabc123', t: 0 });
});

test('start time from t= and start=, in the query or the fragment', () => {
  assert.equal(parseUrl('https://youtu.be/_JZom_gVfuw?t=42').t, 42);
  assert.equal(parseUrl('https://www.youtube.com/watch?v=_JZom_gVfuw&start=90').t, 90);
  assert.equal(parseUrl('https://www.youtube.com/watch?v=_JZom_gVfuw#t=7').t, 7);
});

test('rubbish gives no id and no list', () => {
  assert.deepEqual(parseUrl('hello'), { id: null, list: null, t: 0 });
  assert.deepEqual(parseUrl(''), { id: null, list: null, t: 0 });
  assert.deepEqual(parseUrl(null), { id: null, list: null, t: 0 });
  assert.equal(parseUrl('https://example.com/watch?v=short').id, null);
});

test('watchUrl builds the same links as the Mac', () => {
  assert.equal(watchUrl('abcdefghijk', null, 0, -1), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(watchUrl('abcdefghijk', null, 75, -1), 'https://www.youtube.com/watch?v=abcdefghijk&t=75s');
  assert.equal(watchUrl('abcdefghijk', 'RDx', 75, 2), 'https://www.youtube.com/watch?v=abcdefghijk&t=75s&list=RDx&index=3');
  assert.equal(watchUrl('abcdefghijk', 'RDx', 0, -1), 'https://www.youtube.com/watch?v=abcdefghijk&list=RDx');
});
