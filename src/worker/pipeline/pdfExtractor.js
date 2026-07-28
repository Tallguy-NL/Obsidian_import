const path = require('path');
const { fork } = require('child_process');
const { withTimeout } = require('./withTimeout');
const { PDF_EXTRACTION_TIMEOUT_MS } = require('../../shared/constants');

const CHILD_ENTRY = path.join(__dirname, 'pdfExtractorChildProcess.js');

let child = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> {resolve, reject}

/**
 * Lazily forks a single persistent PDF-extraction child process, reused across extractPdfText()
 * calls (pdf.js's dynamic import() has real overhead, so we don't want to pay it per file). A
 * real OS process rather than an in-process call: a wedged pdf.js parse or @napi-rs/canvas
 * render — pdf.js's Node/worker-thread misdetection makes those indistinguishable from a slow
 * one — would otherwise block this worker's single JS thread past every Promise.race deadline,
 * silently freezing the whole tick loop (import polling AND backfill, across every vault) since
 * a new tick never starts until the previous one finishes. A hang like that can only be
 * recovered with an unconditional SIGKILL, which requires a process boundary, not just a
 * same-process timeout — the same reasoning ocrEngine.js already applies to tesseract.
 */
function spawnChild() {
  // `detached: true` makes this child the leader of its own process group rather than sharing
  // the worker's — pdfExtractorChildProcess.js forks its own nested OCR child for scanned-PDF
  // pages (see ocrEngine.js/ocrChildProcess.js), which inherits this new group. Killing by group
  // (see killChild below) then takes both processes out atomically; killing just this PID would
  // leave that nested OCR child orphaned and un-managed the moment this one dies, since a plain
  // process.exit()/SIGKILL never cascades to grandchildren on its own.
  const proc = fork(CHILD_ENTRY, [], { stdio: 'pipe', detached: true });

  proc.on('message', ({ id, ok, result, error }) => {
    const waiter = pending.get(id);
    if (!waiter) return; // already timed out and abandoned
    pending.delete(id);
    if (ok) waiter.resolve(result);
    else waiter.reject(new Error(error));
  });

  proc.on('exit', (code) => {
    // A crash (or our own post-timeout SIGKILL) would otherwise leave any in-flight request's
    // promise unresolved forever.
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`PDF extraction child process exited unexpectedly (code ${code})`));
    }
    pending.clear();
    if (child === proc) child = null;
  });

  proc.stdout?.on('data', (chunk) => process.stdout.write(`[pdfExtractorChild] ${chunk}`));
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[pdfExtractorChild:err] ${chunk}`));

  return proc;
}

function getChild() {
  if (!child) child = spawnChild();
  return child;
}

// Targets the whole process group (negative pid) rather than just this one process, so the
// nested OCR child this process may itself have forked (see spawnChild's `detached: true`
// comment) dies with it instead of surviving as an unreachable orphan. Group kill is POSIX-only
// (throws on Windows, where electron-builder.yml still ships an nsis target) — proc.kill() below
// always runs too, so the direct child is still reaped there even though the nested grandchild
// wouldn't be (see pdfExtractorChildProcess.js's own `disconnect` handler for that case instead).
function killChildGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // not supported (Windows), or the group is already gone — fall through to the direct kill
  }
  proc.kill('SIGKILL'); // safe/no-op if already dead
}

// pdf.js's Node/worker-thread misdetection (see pdfExtractorChildProcess.js) makes a wedged
// render or parse indistinguishable from a slow one — this timeout is the backstop against a
// single bad PDF freezing the whole worker tick loop forever. Logged before starting so the
// last log line names the file if it does time out.
async function extractPdfText(filePath) {
  console.log(`[pdfExtractor] extracting: ${filePath}`);
  const proc = getChild();
  const id = nextRequestId;
  nextRequestId += 1;
  const resultPromise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  // A losing resultPromise below is abandoned, not cancelled — swallow its eventual settlement
  // so it doesn't surface as an unhandled rejection once the timeout has already won.
  resultPromise.catch(() => {});
  proc.send({ id, filePath });
  try {
    return await withTimeout(resultPromise, PDF_EXTRACTION_TIMEOUT_MS, `extractPdfText ${filePath}`);
  } catch (err) {
    if (String(err.message).startsWith('Timed out')) {
      console.error(`[pdfExtractor] ${err.message} — killing wedged PDF extraction child process`);
      pending.delete(id);
      if (child === proc) child = null;
      killChildGroup(proc); // SIGTERM assumes the process can still respond; a wedged one can't.
    }
    throw err;
  }
}

async function terminatePdfWorker() {
  if (!child) return;
  const proc = child;
  child = null;
  killChildGroup(proc); // no in-flight request to wait on gracefully, same reasoning as above
}

module.exports = { extractPdfText, terminatePdfWorker };
