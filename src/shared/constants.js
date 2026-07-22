const STATUS = Object.freeze({
  PENDING: 0,
  PROCESSED_NO_TEXT: 200,
  PROCESSED_TEXT_FOUND: 210,
  PROCESSED_TEXT_AND_TAGS: 220,
  NOT_PROCESSED: 400,
  // Failed MAX_PROCESSING_ATTEMPTS times in a row — unlike NOT_PROCESSED (400), this is never
  // retried again (see the status_code guards in importPoller.js/backfillScanner.js), so a
  // permanently broken file (corrupt, password-protected, etc.) stops being retried forever.
  FAILED_PERMANENTLY: 410,
});

// A document that fails this many times in a row is marked FAILED_PERMANENTLY instead of
// NOT_PROCESSED, so it stops being retried on every future tick.
const MAX_PROCESSING_ATTEMPTS = 3;

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
// Per-file extraction deadlines: a hung pdf.js render or wedged tesseract worker must fail the
// one document rather than freeze the whole tick loop forever (see pipeline/withTimeout.js).
const OCR_TIMEOUT_MS = 90_000; // one image/page through tesseract
const PDF_EXTRACTION_TIMEOUT_MS = 300_000; // whole PDF: text layer + up to 5 OCR fallback pages
const HEIC_CONVERT_TIMEOUT_MS = 30_000;
// Same "never freeze the tick loop forever" reasoning as the extraction timeouts above, but for
// the plain fs calls around extraction (copy into attachments, note write, archive/rename) that
// had no deadline of their own — a source/destination folder on a sync drive (iCloud Drive,
// OneDrive, ...) whose file isn't fully downloaded/uploaded yet can block these indefinitely.
// Comfortably above PDF_EXTRACTION_TIMEOUT_MS so a legitimately slow OCR'd PDF isn't cut off by
// the outer deadline before its own inner timeout would've caught it.
const DOCUMENT_PROCESSING_TIMEOUT_MS = 360_000;
// A single standalone fs call outside the main extract/write pipeline above: moving a failed
// file into errors/, or reading one note's raw content while scanning for backlog/tags. Shorter
// than DOCUMENT_PROCESSING_TIMEOUT_MS since it's just one call, not a whole pipeline.
const FILE_IO_TIMEOUT_MS = 30_000;
// Always merged into every processed document's frontmatter tags, so all app-processed notes
// can be found/filtered via a single tag regardless of which content tags were matched.
const AUTO_GUID_TAG = 'guid';

module.exports = {
  STATUS,
  MAX_PROCESSING_ATTEMPTS,
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
  OCR_TIMEOUT_MS,
  PDF_EXTRACTION_TIMEOUT_MS,
  HEIC_CONVERT_TIMEOUT_MS,
  DOCUMENT_PROCESSING_TIMEOUT_MS,
  FILE_IO_TIMEOUT_MS,
};
