/**
 * Caveats that have to read correctly on a page nobody is watching.
 *
 * The gas subsidy is the one that goes stale by itself: it is correct today and silently
 * wrong the day after it ends, when a reader would be told a subsidy "ends" on a date that
 * has passed. So the tense is derived from the date rather than written into the copy, and
 * the build ships both sentences.
 *
 * The depth-page findings that used to live here moved to archive/lib/findings.js with the
 * page they belong to; that file re-exports this one so there is a single implementation.
 */

/**
 * The gas-subsidy caveat, in the right tense for the day it is being read.
 * @param {{ends: string, label: string, before_text: string, after_text: string}} subsidy
 * @param {Date} [now]
 * @returns {{label: string, text: string, past: boolean}}
 */
export function subsidyNote(subsidy, now = new Date()) {
  const ends = new Date(`${subsidy.ends}T00:00:00Z`);
  const past = now.getTime() >= ends.getTime();
  return { label: subsidy.label, text: past ? subsidy.after_text : subsidy.before_text, past };
}
