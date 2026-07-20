function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Below this length a tag is indistinguishable from a stray letter or common stopword (e.g.
// "c", "t", "de", "en") and will spuriously word-boundary-match almost any block of prose —
// exclude these from auto-matching regardless of how they ended up in the known-tag vocabulary.
const MIN_MATCHABLE_TAG_LENGTH = 3;

/**
 * Case-insensitive, word-boundary match of each known vault tag against extracted text.
 * Multi-word tags (e.g. "acme corp") are matched as a phrase; hyphenated tags match literally.
 * Returns the subset of knownTags that appear in text, in their original (lowercase) form.
 */
function matchTags(text, knownTags) {
  if (!text || !knownTags || knownTags.length === 0) return [];
  const haystack = text;
  const matched = [];
  for (const tag of knownTags) {
    if (!tag || tag.length < MIN_MATCHABLE_TAG_LENGTH) continue;
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(tag)}(?![\\w-])`, 'i');
    if (pattern.test(haystack)) matched.push(tag);
  }
  return matched;
}

module.exports = { matchTags };
