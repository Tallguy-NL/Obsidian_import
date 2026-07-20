const { DateTime } = require('luxon');
const { isWithinScheduleWindow } = require('../shared/time');

/**
 * Thin, settings-shaped wrapper around shared/time.js's DST-safe window check — the single
 * place worker/index.js asks "am I allowed to do background work right now?".
 */
function isWorkerAllowedToRunNow(settings) {
  return isWithinScheduleWindow(
    DateTime.utc(),
    settings.timezone,
    settings.scheduleDaysMask,
    settings.scheduleStartMinutes,
    settings.scheduleEndMinutes
  );
}

module.exports = { isWorkerAllowedToRunNow };
