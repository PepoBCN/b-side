'use strict';
// Power events to pause reasons. A locked PC also fires "resume" when it wakes, which must not
// start the video behind the lock screen, so resume does nothing while locked.

function createPowerHandlers(smartPause) {
  let locked = false;
  return {
    isLocked: function () { return locked; },
    onLock: function () { locked = true; smartPause('lock', true); },
    onUnlock: function () { locked = false; smartPause('lock', false); },
    onSuspend: function () { smartPause('lock', true); },
    onResume: function () { if (!locked) smartPause('lock', false); },
    onBattery: function () { smartPause('battery', true); },
    onAc: function () { smartPause('battery', false); }
  };
}

module.exports = { createPowerHandlers };
