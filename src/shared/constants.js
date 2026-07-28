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
// Independent of the tick loop on purpose (see worker/index.js/workerBridge.js) — a stuck
// backfill item can legitimately keep a single tick running for minutes, but this timer firing
// at all is what tells the main process the worker's JS event loop isn't wedged, since a truly
// blocked thread would starve this timer too.
const HEARTBEAT_INTERVAL_MS = 15_000;
// Longest a single worker operation (a tick, or the on-demand 'analyze-vault' handler — see
// worker/index.js's activeOperations) may run before it's treated as wedged and restarted, even
// though the heartbeat itself is still arriving on schedule (see workerBridge.js's
// checkHeartbeat()). The heartbeat only proves the worker's event loop isn't frozen — it says
// nothing about whether the work in flight is making progress, which is exactly the gap that let
// a full vault rescan with no overall deadline (findBacklog() over tens of thousands of notes)
// run for two-plus hours undetected. A normal tick finishes in low single-digit seconds even on
// a large vault, so 10 minutes is already generous slack for one that's merely slow (a big
// 'analyze-vault' run included) without leaving a genuinely wedged one unrecovered for long.
const MAX_TICK_DURATION_MS = 600_000; // 10 minutes
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
  HEARTBEAT_INTERVAL_MS,
  MAX_TICK_DURATION_MS,
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
