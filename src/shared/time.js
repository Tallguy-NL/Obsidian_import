const { DateTime } = require('luxon');

function nowUtcIso() {
  return DateTime.utc().toISO();
}

function isDayAllowed(daysMask, local) {
  // luxon weekday: 1=Monday .. 7=Sunday -> bit index 0=Monday .. 6=Sunday
  const bitIndex = local.weekday - 1;
  return (daysMask & (1 << bitIndex)) !== 0;
}

/**
 * Returns true if `now` (a JS Date or luxon DateTime, UTC) falls within the configured
 * weekly schedule window, evaluated in the given IANA timezone.
 * daysMask: bit0=Monday .. bit6=Sunday (1 = allowed).
 * startMinutes/endMinutes: minutes since local midnight, endMinutes may equal 1440 (=midnight).
 * When startMinutes > endMinutes the window spans midnight (e.g. 19:00-07:00); which day's mask
 * bit governs is always the day the window *started* on, not the calendar day `now` falls on —
 * so a Monday-enabled/Tuesday-disabled mask still allows the Monday-night window through to
 * 07:00 Tuesday morning.
 */
function isWithinScheduleWindow(now, timezone, daysMask, startMinutes, endMinutes) {
  const local = (now instanceof DateTime ? now : DateTime.fromJSDate(now)).setZone(timezone || 'UTC');
  if (!local.isValid) return false;

  const minutesSinceMidnight = local.hour * 60 + local.minute;

  if (startMinutes <= endMinutes) {
    if (!isDayAllowed(daysMask, local)) return false;
    return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
  }

  // Overnight window: today's evening leg is gated by today's bit; the small-hours leg
  // (before endMinutes) belongs to *yesterday's* start of window, so gated by yesterday's bit.
  if (minutesSinceMidnight >= startMinutes) {
    return isDayAllowed(daysMask, local);
  }
  if (minutesSinceMidnight < endMinutes) {
    return isDayAllowed(daysMask, local.minus({ days: 1 }));
  }
  return false;
}

/**
 * Start of the current local week (Monday 00:00) in the given timezone, returned as a UTC ISO string,
 * for "documents added this week" boundary comparisons against discovered_at_utc.
 * Computed manually via the ISO weekday (1=Monday..7=Sunday, locale-independent in luxon) rather than
 * DateTime#startOf('week'), which snaps to the locale's week start (Sunday for en-US) instead of Monday.
 */
function startOfLocalWeekUtcIso(timezone) {
  const local = DateTime.now().setZone(timezone || 'UTC');
  const monday = local.minus({ days: local.weekday - 1 }).startOf('day');
  return monday.toUTC().toISO();
}

module.exports = {
  nowUtcIso,
  isWithinScheduleWindow,
  startOfLocalWeekUtcIso,
};
