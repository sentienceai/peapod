/**
 * The trader profile dialog, in each of the three answers an address can have.
 *
 * WHAT THIS FILE INHERITS. The old detail-view test, moved to the rebuilt dialog: no
 * perps-state fields, no placeholder where a value was cut, every label shipping its
 * criteria, a win/loss strip that reads without colour, and tabs only for data that exists.
 *
 * THE THIRD ANSWER IS THE ONE THAT GETS LOST. An address that traded and never closed a
 * round-trip is not "not found" — it is most of the chain: about 73,900 of the 103,920
 * addresses in this window. The rebuilt frontend dropped that case (`status === 'qualified'
 * ? d : null`) and it is restored here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { byClass, openPage, signChannels, slots, wiredText } from './page.mjs';
import { sample } from './store.mjs';

const { get } = await openPage('leaderboard', 'board');
const { openProfile, closeProfile } = await import('../web/lib/profile.js');
const doc = /** @type {any} */ (globalThis.document);

/** The dialog mounts on document.body; the stub keeps what was appended to it. */
const panel = () => byClass(doc.body, 'profile-panel')[0] ?? null;
/** @param {string} address */
async function open(address) {
  await openProfile(address);
  await new Promise((r) => { setTimeout(r, 400); });
  return panel();
}

const qualified = sample({ where: 'round_trips > 40 ORDER BY round_trips DESC', limit: 1 })[0];
const silent = sample({ where: 'round_trips = 0', limit: 1 })[0];

test('an address with closed round-trips gets its record', async () => {
  const p = await open(qualified.address);
  assert.ok(p, 'the dialog did not mount');
  const text = p.textContent;
  assert.ok(text.includes(qualified.address.slice(0, 6)), 'the dialog is not about this address');
  // Every signed figure keeps all three channels here too.
  const wrong = signChannels(p);
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
  // The rail carries what the build measures.
  for (const required of ['Trading style', 'Median hold', 'Longest win streak', 'Percentile',
    'Realized drawdown', 'Return on matched cost']) {
    assert.ok(text.includes(required), `the rail is missing ${required}`);
  }
});

test('the two honest figures say what they are, and the account-level ones say what they need', async () => {
  const p = panel();
  const text = wiredText(p);
  // Named for what they measure, with what they exclude beside them.
  assert.match(text, /Not account drawdown/);
  assert.match(text, /Not account ROI/);
  assert.ok(!/Max drawdown/.test(text), 'a figure took the frame\'s account-level name');
  // And the four the transfer index owes, as slots rather than numbers.
  const metrics = slots(p).map((/** @type {any} */ s) => s.dataset.metric).sort();
  for (const m of ['accountValue', 'drawdown', 'roi', 'sharpe']) {
    assert.ok(metrics.includes(m), `${m} has no slot on the profile`);
  }
  for (const s of slots(p)) {
    assert.ok(!/[$%]|\d[.,]\d/.test(s.textContent), `a slot carries a figure: ${s.textContent}`);
    assert.match(s.textContent, /transfer index|execution|definition|longer tape/i);
  }
});

test('every label ships the rule that earns it', async () => {
  const items = byClass(panel(), 'profile-label');
  assert.ok(items.length >= 4, `only ${items.length} labels`);
  for (const item of items) {
    const small = item.byTag('small');
    assert.equal(small.length, 1, 'a label has no criteria');
    assert.ok(small[0].textContent.length > 25, `criteria too thin: ${small[0].textContent}`);
    assert.ok(['true', 'false'].includes(item.dataset.earned));
  }
  assert.ok(!panel().textContent.toLowerCase().includes('smart money'), 'a smart-money label appeared');
});

test('the tabs are only what the data fills, and none of them is called Positions', async () => {
  const tabs = byClass(panel(), 'profile-tab').map((/** @type {any} */ t) => t.textContent.replace(/\d+$/, '').trim());
  // "Positions" is the frame's word for a table of closed round-trips. A position is
  // something held, and this build cannot see holdings at all.
  assert.ok(!tabs.includes('Positions'), 'a tab is called Positions');
  assert.deepEqual(tabs, ['Round-trips', 'Trades', 'Tokens', 'Performance']);
  for (const absent of ['Balances', 'Transfers', 'Orders', 'Fills', 'TWAP']) {
    assert.ok(!tabs.includes(absent), `${absent} appeared without the transfer index`);
  }
  // No placeholder where a value was cut: a dash in a financial field reads as a measured zero.
  const values = byClass(panel(), 'profile-rail-value').map((/** @type {any} */ v) => v.textContent.trim());
  assert.deepEqual(values.filter((/** @type {string} */ v) => ['—', '-', 'N/A', ''].includes(v)), [],
    'a rail row renders a placeholder where a value was cut; cut the row instead');
});

test('the win rate is the chance test, and the verdict is neutral', async () => {
  const ev = byClass(panel(), 'ev')[0];
  assert.ok(ev, 'the profile has no evidence bar');
  assert.equal(byClass(ev, 'ev-null').length, 1, 'the 50% null is not drawn');
  assert.equal(byClass(ev, 'ev-band').length, 1, 'the chance region is gone');
  assert.equal(byClass(ev, 'ev-mark').length, 1, 'the observed mark is gone');
  const verdict = byClass(ev, 'ev-verdict')[0];
  assert.ok(!/(^|\s)(up|down)(\s|$)/.test(verdict.className || ''), 'the verdict took a sign colour');
  assert.match(byClass(ev, 'ev-foot')[0].textContent, /^\d+ of \d+ closes · chance \d+–\d+%$/);
});

test('the win/loss strip reads without colour', async () => {
  const squares = byClass(panel(), 'profile-card-square');
  assert.ok(squares.length > 0, 'no win/loss strip');
  // Losses are outlined, wins filled: the distinction survives colour being stripped.
  assert.ok(squares.some((/** @type {any} */ s) => /down/.test(s.className))
    || squares.every((/** @type {any} */ s) => /up/.test(s.className)),
  'losses are not distinguishable from wins by shape');
});

test('an address that traded and never closed is told what it did do', async () => {
  const p = await open(silent.address);
  const text = p.textContent;
  assert.ok(!/Not in this tape/.test(text), 'an address that traded was reported as absent');
  assert.match(text, /nothing closed|no completed round-trip/i);
  // What it DID do, from the build's own explanation.
  assert.match(text, /out of scope, not estimated|no cost basis/i);
  // And no realized figure at all rather than a zero: a zero reads as "broke even".
  assert.ok(!/\+\$0\.00|−\$0\.00/.test(text), 'a zero was rendered where there is no figure');
  assert.equal(byClass(p, 'ev').length, 0, 'a chance band was drawn over no closes');
});

test('an address the tape has never seen is told that, and told what it means', async () => {
  const p = await open(`0x${'ab'.repeat(20)}`);
  const text = p.textContent;
  assert.match(text, /Not in this tape/);
  assert.match(text, /not the same as never having traded|outside it is invisible here/i);
});

test('the dialog traps focus, closes three ways, and hands focus back', async () => {
  const from = /** @type {any} */ (byClass(get('rows'), 'row')[0]);
  doc.activeElement = from;
  await openProfile(qualified.address, from);
  await new Promise((r) => { setTimeout(r, 300); });
  assert.ok(panel(), 'the dialog did not open');
  assert.match(doc.activeElement?.attributes?.['aria-label'] ?? '', /Close trader profile/,
    'opening the dialog left focus outside it');

  // Dispatched on the panel, not on the document: the dialog listens where the event
  // actually arrives — bubbling up from whatever inside it has focus — so a listener on
  // the document would keep firing after the dialog was gone.
  panel().dispatchEvent({ type: 'keydown', key: 'Escape' });
  await new Promise((r) => { setTimeout(r, 100); });
  assert.equal(doc.activeElement, from, 'focus was not returned to what opened the dialog');
  assert.equal(byClass(doc.body, 'backdrop')[0].hidden, true, 'escape did not close the dialog');

  // And the source contract for the other two ways out, which the stub cannot press.
  const src = await readFile(new URL('../web/lib/profile.js', import.meta.url), 'utf8');
  assert.match(src, /e\.target === backdropEl/, 'a click anywhere would close the dialog');
  assert.match(src, /aria-modal/);
  closeProfile();
});

test('a caption under a figure produces that figure', async () => {
  /*
   * The "Volume matched" card carries coverage — the share of this address's SELLING that had
   * an on-chain buy behind it — over a caption that read "$2.3M matched of $2.5M total". That
   * is a different ratio: matched against everything the address traded, open positions
   * included. It came out at 92.9% under a figure reading 100.0%, so a reader who checked the
   * arithmetic was right and the page was wrong. The two parts named underneath a figure have
   * to be the two parts it is made of.
   */
  const p = await open(qualified.address);
  const card = byClass(p, 'profile-card')
    .find((/** @type {any} */ c) => c.textContent.startsWith('Volume matched'));
  assert.ok(card, 'the volume card is gone');
  const value = byClass(card, 'profile-card-value')[0].textContent;
  const foot = byClass(card, 'profile-card-foot')[0].textContent;
  assert.match(foot, /matched/);
  assert.match(foot, /no on-chain buy/, 'the caption does not name what is unmatched');
  assert.ok(!/of \$[\d.]+[MBk]? total/.test(foot),
    `the caption is a ratio against total volume, which is not the figure above it: ${value} / ${foot}`);
  closeProfile();
});
