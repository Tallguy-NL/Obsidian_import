const path = require('path');

// Matches "Base name [n].ext" duplicate-suffix convention, e.g. "Receipt [1].pdf".
const DUP_SUFFIX_RE = /^(.*?)(?:\s?\[(\d+)\])?$/;

/**
 * Parses a filename into { base, dupIndex, ext, groupKey }. Files sharing the same groupKey
 * (same base name, differing only by a trailing "[n]") are treated as one note's attachments.
 */
function parseFileName(fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const stem = path.basename(fileName, path.extname(fileName));
  const match = stem.match(DUP_SUFFIX_RE);
  const base = (match?.[1] || stem).trim();
  const dupIndex = match?.[2] !== undefined ? Number(match[2]) : null;
  return { base, dupIndex, ext, groupKey: base };
}

module.exports = { parseFileName };
