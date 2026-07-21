// Tracks documents currently being worked on (extraction/OCR/tagging in progress) so the
// renderer can show live "now processing" feedback instead of just a generic "running" dot.
// A backfill tick can chew through BACKFILL_ITEMS_PER_TICK (10) items in well under a second
// each, so a snapshot of only what's in-flight *right now* would flash by unreadably fast.
// Instead this keeps a short rolling history — recently-started items stay listed (marked
// done, not pulsing) after they finish, until newer activity pushes them out — so a whole
// tick's worth of work is visible at once, not just whichever single item happens to be
// running at the instant a listener asks.
const HISTORY_LIMIT = 12;
let nextToken = 1;
const active = new Set(); // tokens currently in-flight
let history = []; // entries, most recent first; oldest falls off past HISTORY_LIMIT

function post() {
  const items = history.map(({ token, ...rest }) => ({ ...rest, inProgress: active.has(token) }));
  process.parentPort.postMessage({ type: 'processingStatusChanged', items });
}

function start({ vaultId, vaultName, documentName }) {
  const token = nextToken;
  nextToken += 1;
  active.add(token);
  history.unshift({ token, vaultId, vaultName, documentName });
  history = history.slice(0, HISTORY_LIMIT);
  post();
  return token;
}

function finish(token) {
  active.delete(token);
  post();
}

module.exports = { start, finish };
