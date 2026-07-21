// A single stuck file (a pdf.js render that never resolves, a wedged tesseract worker) must
// never be allowed to hang forever: worker/index.js's tick loop only starts a new tick once the
// previous one has fully finished, so one hung extraction silently freezes the entire background
// worker (import polling AND vault backfill) with no crash and no error to point at. Every
// extraction call is raced against a deadline instead, so a hang surfaces as a normal failed
// document (400, with a "timed out" message naming the file) rather than an outage.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
