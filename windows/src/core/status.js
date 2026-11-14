'use strict';
// The panel state, also written to status.json by the `status` command.
const { parseUrl } = require('./url');

const ERROR_SHOW_MS = 8000;

// Message for a player error code. 101, 150 and 152 all mean the owner blocks embedding.
function playerErrorText(code) {
  if (code === 101 || code === 150 || code === 152) return 'The owner of this video blocks playing it outside YouTube.';
  if (code) return 'YouTube could not play this video (error ' + code + ').';
  return null;
}

function panelState(c) {
  const p = parseUrl(c.current || '');
  const main = c.main || {};
  const err = c.error && c.now - c.errorAt < ERROR_SHOW_MS ? c.error : null;
  return {
    on: !!c.on,
    mode: c.mode,
    error: err || (c.on ? c.playerError || null : null),
    pausedBy: c.pausedBy || null,
    screens: c.screens,
    now: c.on ? { id: main.id || p.id, title: main.title || '', author: main.author || '', t: main.t || 0, d: main.d || 0,
                  playing: main.s === 1, buffering: main.s === 3, list: !!p.list } : null,
    settings: c.settings,
    recents: c.recents,
    canResume: !!c.last,
    version: c.version || '',
    players: c.players || 0,
    followers: c.followers || [],
    panelOpen: !!c.panelOpen,
    shortcuts: c.shortcuts || { enabled: false, registered: [], failed: [] },
    wallpaper: c.wallpaper || { method: 'none', parentClass: '' },
    platform: c.platform
  };
}

module.exports = { ERROR_SHOW_MS, playerErrorText, panelState };
