/**
 * The leaderboard, rendered from the shipped store.
 *
 * WHAT THIS FILE INHERITS. It replaces the old leaderboard test, which pinned the same
 * decisions against a page that no longer exists. Every assertion here was one there, moved
 * to the rebuilt page rather than dropped with the file it used to point at:
 *
 *   - the coverage caveat states scope BEFORE any ranking, in the build's own figures
 *   - the ranking says it is truncated rather than implying it is complete
 *   - every signed figure carries a glyph AND a sign character AND a sign class
 *   - a rate, a share and a count stay in the neutral channel
 *   - a medal carries its rank as a numeral, not only as a colour
 *   - every address on the board can be copied, at full length
 *   - no perps-state column survived
 *   - the tabs offer only windows and universes the build actually publishes
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { byClass, openPage, placeholders, signChannels } from './page.mjs';
import { index, view } from './store.mjs';

const { get } = await openPage('leaderboard', 'board');
const board = view('all', index().windows.at(-1).window);

test('the coverage caveat states scope, in the build\'s own figures', () => {
  const note = get('note').textContent;
  const c = board.coverage;
  // The claims the whole site rests on, in the words the build ships.
  assert.match(note, /round-trips only/i);
  assert.match(note, /out of scope, not estimated/);
  assert.ok(note.includes(c.window_label), 'the caveat does not say which window');
  assert.ok(note.includes(c.universe), 'the caveat does not say which pools');
  assert.ok(note.includes(c.addresses_qualifying.toLocaleString('en-US')));
  assert.ok(note.includes(c.addresses_seen.toLocaleString('en-US')));
  assert.ok(note.includes(`${c.qualifying_pct.toFixed(1)}%`), 'the real qualifying rate is missing');
  assert.ok(note.includes(`${c.matched_flow_pct.toFixed(1)}%`), 'the real matched-flow share is missing');
  // The ranking is capped and says so: presenting the top N as the whole field would
  // overstate both an address's rank and the size of what it beat.
  assert.ok(c.rows_shown < c.addresses_qualifying, 'this assertion is moot if the cap exceeds the field');
  assert.ok(note.includes(c.truncation_note), 'the caveat does not disclose the cap');
  // And the gas subsidy, in the right tense for the day it is read.
  assert.match(note, /2026-09-29/);
  assert.match(note, /gas subsidy/);
  assert.match(note, /\bends\b|\bended\b/);
});

test('the rows are the build\'s rows, in its order', () => {
  const rows = byClass(get('rows'), 'row');
  assert.ok(rows.length >= 12, `only ${rows.length} rows rendered`);
  const top = [...board.rows].sort((/** @type {any} */ a, /** @type {any} */ b) => b.realized - a.realized)[0];
  assert.ok(rows[0].textContent.includes(top.address.slice(0, 6)),
    'the first row is not the build\'s top realized address');
  const podium = byClass(get('podium'), 'pcard');
  assert.equal(podium.length, 3, 'the podium is not three cards');
});

test('every signed figure carries a glyph, a sign character and a sign class', () => {
  // Colour plus a minus sign is two channels for most readers but not for someone
  // colourblind scanning a dense column, and a minus sign is a few pixels wide.
  const wrong = [...signChannels(get('rows')), ...signChannels(get('podium'))];
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
  assert.ok(byClass(get('rows'), 'up').length + byClass(get('rows'), 'down').length > 10,
    'no signed figures found at all');
});

test('only a signed figure is allowed a sign colour', () => {
  /*
   * WHY THIS EXISTS. Win rate used to render green above 60%, amber in the middle and red
   * below 45. On this palette the positive colour is a green no other column uses, so 88.2%
   * drawn in it reads as +88.2% — which it is not. A win rate is a rate, and a high one over
   * tiny round-trip counts is the exact thing the coverage caveat exists to warn about.
   *
   * Asserted on the rendered table rather than on the stylesheet, so it survives a re-skin
   * that renames every colour.
   */
  /** @type {string[]} */
  const offenders = [];
  for (const row of byClass(get('rows'), 'row')) {
    for (const cell of row.descendants()) {
      if (!/(^|\s)(up|down)(\s|$)/.test(cell.className || '')) continue;
      if (!/[+−]/.test(cell.textContent)) {
        offenders.push(`"${cell.textContent.trim()}" is coloured as a sign but carries no sign`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

test('a medal carries its rank as a numeral, not only as a colour', () => {
  const medals = byClass(get('podium'), 'medal').concat(byClass(get('rows'), 'medal'));
  assert.ok(medals.length >= 3, `only ${medals.length} medals`);
  for (const m of medals.slice(0, 3)) {
    assert.match(m.textContent.trim(), /^[123]$/, `a medal is colour-only: "${m.textContent}"`);
  }
});

test('every address on the board can be taken, at full length', () => {
  const buttons = byClass(get('rows'), 'copybtn').concat(byClass(get('podium'), 'copybtn'));
  assert.ok(buttons.length > 10, `only ${buttons.length} copy buttons`);
  for (const b of buttons) {
    const label = b.attributes['aria-label'];
    // The visible text is shortened. What gets copied, and what a screen reader hears, must
    // not be.
    assert.match(label, /^Copy address 0x[0-9a-f]{40}$/, `copy button does not name a full address: ${label}`);
    assert.ok(!label.includes('…'));
  }
});

test('no perps state, and no figure the build cannot make', () => {
  const head = get('thead').textContent.toLowerCase();
  for (const banned of ['account value', 'equity', 'leverage', 'margin', 'liquidation',
    'unrealized', 'copy score', 'portfolio']) {
    assert.ok(!head.includes(banned), `the ranking has a column it cannot fill: ${banned}`);
  }
  // What it has instead, which is measured.
  assert.match(head, /realized/);
  assert.match(head, /matched vol/);
  assert.match(head, /covered/);
});

test('the tabs offer only what the build publishes', () => {
  const windowLabels = get('windows').byTag('button').map((/** @type {any} */ b) => b.textContent);
  const universeLabels = get('universes').byTag('button').map((/** @type {any} */ b) => b.textContent);
  // The manifest's windows, not a literal: a tape younger than seven days publishes only
  // 24h, and a tab offering 30D would answer with a window that is not there.
  assert.deepEqual(windowLabels, index().windows.map((/** @type {any} */ w) => String(w.label).toUpperCase()));
  assert.deepEqual(universeLabels, ['All', 'Stocks', 'Memecoins']);
  for (const b of [...get('windows').byTag('button'), ...get('universes').byTag('button')]) {
    assert.equal(typeof b.onclick, 'function', `${b.textContent} is inert`);
    assert.ok(['true', 'false'].includes(b.attributes['aria-pressed']), 'a tab has no pressed state');
  }
});

test('a logo goes where the ticker is written, and a letter where it is not', () => {
  /*
   * BOTH HALVES OF THIS ARE FAILURES THAT SHIPPED.
   *
   * First the map never arrived: 433 vendored files, and every tile on the site drawing two
   * letters because two pages built tiles by hand instead of calling the helper.
   *
   * Then the logos arrived everywhere, including the "top assets" column — three 22px chips
   * overlapping by 6px, with no ticker written next to them. A square photograph drawn over
   * those chips covers the only letters naming the token and leaves cropped artwork behind:
   * the column became unreadable, and none of the frames put a picture there at all. Every
   * identity chip in CopyTrade.dc.html and TraderModal.dc.html carries one letter.
   *
   * So: a stack of chips is letters; a tile with the ticker beside it may carry the logo.
   */
  const stack = byClass(get('rows'), 'chipstack');
  assert.ok(stack.length > 5, 'the top-assets column is gone');
  const chips = stack.flatMap((/** @type {any} */ s) => byClass(s, 'asset-tile'));
  assert.ok(chips.length > 5, 'no chips in the stack');
  for (const chip of chips) {
    assert.equal(chip.descendants().filter((/** @type {any} */ n) => n.tag === 'img').length, 0,
      `a logo is drawn over a chip that nothing names: ${chip.title}`);
    assert.equal(chip.textContent.length, 1, `a stacked chip carries ${chip.textContent}`);
  }
});

test('nothing in the rows says "undefined"', () => {
  const junk = [...placeholders(get('rows')), ...placeholders(get('podium'))];
  assert.deepEqual(junk, [], `placeholders on the leaderboard:\n  ${junk.join('\n  ')}`);
});
