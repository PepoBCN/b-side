'use strict';
// Link parsing, identical to the Mac engine.

function parseUrl(url) {
  url = String(url == null ? '' : url);
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
  const l = url.match(/[?&]list=([\w-]+)/);
  const t = url.match(/[?&#](?:t|start)=(\d+)/);
  return { id: m ? m[1] : null, list: l ? l[1] : null, t: t ? parseInt(t[1], 10) : 0 };
}

function watchUrl(id, list, t, index) {
  let u = 'https://www.youtube.com/watch?v=' + id;
  if (t) u += '&t=' + t + 's';
  if (list) u += '&list=' + list + (index >= 0 ? '&index=' + (index + 1) : '');
  return u;
}

module.exports = { parseUrl, watchUrl };
