const STATUS = Object.freeze({
  PENDING: 0,
  PROCESSED_NO_TEXT: 200,
  PROCESSED_TEXT_FOUND: 210,
  PROCESSED_TEXT_AND_TAGS: 220,
  NOT_PROCESSED: 400,
});

const SOURCE_TYPE = Object.freeze({
  IMPORT: 'import',
  EXISTING: 'existing',
});

const ALL_IMAGE_EXTENSIONS = Object.freeze([
  'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'heic', 'heif',
]);

const HEIC_EXTENSIONS = Object.freeze(['heic', 'heif']);

const DEFAULT_SETTINGS = Object.freeze({
  timezone: 'UTC',
  scheduleDaysMask: 127, // bit0=Mon .. bit6=Sun, all days on by default
  scheduleStartMinutes: 0,
  scheduleEndMinutes: 1440,
  imageTypesEnabled: ALL_IMAGE_EXTENSIONS,
  workerPaused: false,
  importPollIntervalSeconds: 300,
});

const WEEKDAY_LABELS = Object.freeze([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);

const WORKER_TICK_INTERVAL_MS = 20_000;
const IMPORT_QUEUE_DRAIN_CAP = 20;
// Backfill items processed sequentially (never in parallel) per tick. Previously hardcoded to
// 1, which capped throughput at 1 document per WORKER_TICK_INTERVAL_MS regardless of how much
// faster each item actually finished — this lets a tick keep working through the backlog
// instead of idling out the rest of its 20s window after a single fast item.
const BACKFILL_ITEMS_PER_TICK = 10;
const ERRORS_SUBFOLDER = 'errors';
const GUID_FILENAME_SEPARATOR = '__';
const MIN_TEXT_LAYER_CHARS = 20; // below this, treat a PDF page as scanned/image-only
// Always merged into every processed document's frontmatter tags, so all app-processed notes
// can be found/filtered via a single tag regardless of which content tags were matched.
const AUTO_GUID_TAG = 'guid';

module.exports = {
  STATUS,
  SOURCE_TYPE,
  ALL_IMAGE_EXTENSIONS,
  HEIC_EXTENSIONS,
  DEFAULT_SETTINGS,
  WEEKDAY_LABELS,
  WORKER_TICK_INTERVAL_MS,
  IMPORT_QUEUE_DRAIN_CAP,
  BACKFILL_ITEMS_PER_TICK,
  ERRORS_SUBFOLDER,
  GUID_FILENAME_SEPARATOR,
  MIN_TEXT_LAYER_CHARS,
  AUTO_GUID_TAG,
};
