'use strict';
// Screensaver mode ignores input for its first few seconds, then ends on a click, a key or a
// deliberate mouse move. A nudge of the trackpad while walking away doesn't count.

const GRACE_MS = 3000;
const MOVE_PX = 120;

class Saver {
  constructor(now) {
    this.now = now || Date.now;
    this.since = 0;
    this.move = 0;
    this.moveAt = 0;
  }

  enter() { this.since = this.now(); this.move = 0; this.moveAt = 0; }

  // kind: 'click' | 'key' | 'move'. Returns the reason text when the saver should end, else null.
  input(kind, px) {
    const t = this.now();
    if (t - this.since < GRACE_MS) return null;
    if (kind === 'click') return 'click';
    if (kind === 'key') return 'key';
    if (kind === 'move') {
      if (t - this.moveAt > 1000) this.move = 0;
      this.moveAt = t;
      this.move += Number(px) || 0;
      if (this.move > MOVE_PX) return 'mouse move';
    }
    return null;
  }

  // The system idle time in seconds, polled while the saver runs. Windows reports input in other
  // windows too, so under a second idle after the grace period means a key or mouse was used.
  idle(seconds) {
    return Number(seconds) < 1 ? this.input('key') : null;
  }
}

module.exports = { GRACE_MS, MOVE_PX, Saver };
