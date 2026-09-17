/**
 * The sample-data mark, per figure.
 *
 * WHY NOT ONE MARK PER PAGE. The old shape was a single flag: "this build is sample data",
 * rendered once in the footer. It fails in the direction that matters. The moment the rows
 * go live the flag goes false and the mark disappears from the whole page — including from
 * the figures beside them that are still invented, which are now the ones nobody is warned
 * about. A page is rarely all real or all fake; it is real in the places the endpoints have
 * reached and invented everywhere else, and the mark has to move at that granularity.
 *
 * So a payload names its own sample fields (`sampleFields` from lib/data.js) and each figure
 * asks about itself. Removing a mark is then what it should be: one field landing, one entry
 * disappearing from that list, and nothing else in the interface changing.
 */

import { isSampleField } from './data.js';
import { node } from './format.js';

/**
 * The mark itself. Text, not a colour or an icon: it has to survive greyscale, a screen
 * reader and a screenshot.
 * @param {string} why what would have to exist for this figure to be real
 */
export function sampleMark(why) {
  const tag = node('span', 'sample-tag', 'Sample data');
  tag.title = why;
  tag.setAttribute('role', 'note');
  return tag;
}

/**
 * Mark one figure, if and only if its own field is sample data.
 * @param {HTMLElement} host the element holding the figure
 * @param {{sampleFields?: string[]} | null | undefined} payload
 * @param {string} field the field name as lib/data.js reports it
 * @param {string} why
 * @returns {boolean} whether a mark was added
 */
export function markSample(host, payload, field, why) {
  // '*' is the whole-payload case: lib/mock.js answering, where every figure is invented.
  if (!isSampleField(payload, field) && !isSampleField(payload, '*')) return false;
  host.dataset.sample = field;
  host.append(sampleMark(why));
  return true;
}
