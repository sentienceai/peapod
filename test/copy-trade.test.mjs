/**
 * The copy-trade grid and the setup window it opens.
 *
 * WHAT THIS FILE INHERITS. It replaces the old traders-page test. The frame it is built
 * from ends each card in a 0–100 Copy Score and a Copytrade button; there is no score and
 * no execution, and the assertions below fail if either appears. A fabricated score is the
 * exact failure this project refuses, and a copy button with nothing behind it is worse.
 *
 * THE BAND IS THE EXACT BINOMIAL. The rebuilt frontend arrived with its own normal
 * approximation — 0.5 ± 1.96·√(0.25/n), continuity-corrected — in two files. That is the
 * bug an earlier pass removed: it calls four wins from four "beyond chance" when the true
 * probability is one in eight. Both copies are gone and every caller uses lib/evidence.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { byClass, openPage, signChannels, slots, wiredText } from './page.mjs';
import { chanceBand, CRITERION } from '../web/lib/evidence.js';
import { index, view } from './store.mjs';

const { get } = await openPage('copy-trade', 'copy-page');
const board = view('all', index().windows.at(-1).window);
const cards = () => byClass(get('copy-main'), 'ct-card');

test('the grid is real traders from the build', () => {
  assert.ok(cards().length >= 8, `only ${cards().length} cards`);
  const first = cards()[0].textContent;
  const top = [...board.rows].sort((/** @type {any} */ a, /** @type {any} */ b) => b.realized - a.realized)[0];
  assert.ok(first.includes(top.address.slice(0, 6)), 'the first card is not the build\'s top address');
  const wrong = signChannels(get('copy-main'));
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('the band on every card is the exact binomial, and the verdict is one the test supports', () => {
  // The four labels lib/evidence.js can produce, and no others. "Too few closes to tell" is
  // the one an approximation loses: below six closes no result can clear the bar, and the
  // most extreme outcome available is 2·(1/2)^n — 0.0625 at five, 0.031 at six.
  const allowed = [/^Beyond chance$/, /^Within chance$/, /^Below chance$/,
    /^Too few closes to tell \(\d+\)$/, /^No closed round-trips$/];
  for (const card of cards()) {
    const verdict = byClass(card, 'ev-verdict')[0];
    assert.ok(verdict, 'a card has no verdict');
    assert.ok(allowed.some((re) => re.test(verdict.textContent.trim())),
      `a card invented a verdict: ${verdict.textContent}`);
    // Neutral: a verdict is not a signed quantity.
    assert.ok(!/(^|\s)(up|down)(\s|$)/.test(verdict.className || ''),
      'the verdict took a sign colour');
  }
  // And the band drawn is the band the criterion defines, for this row's own numbers.
  for (const card of cards().slice(0, 6)) {
    const label = card.descendants().find((/** @type {any} */ n) => /^0x[0-9a-f]{4}…/.test(n.textContent ?? ''));
    void label;
    const foot = byClass(card, 'ev-foot')[0].textContent;
    const m = /^(\d+) of (\d+) closes · chance (\d+)–(\d+)%$/.exec(foot);
    assert.ok(m, `the footnote is not the criterion's: ${foot}`);
    const b = chanceBand(Number(m[1]), Number(m[2]));
    assert.equal(Number(m[3]), Math.round(b.lo * 100), 'the drawn band is not the exact region');
    assert.equal(Number(m[4]), Math.round(b.hi * 100));
  }
});

test('no chance band anywhere in the frontend is an approximation', async () => {
  // Two files carried their own copy. One implementation, one place, or they drift — and
  // the one that drifts is the one nobody is reading.
  for (const f of ['copy-page', 'profile', 'board', 'search', 'asset-page']) {
    const src = (await readFile(new URL(`../web/lib/${f}.js`, import.meta.url), 'utf8'))
      // Comments are stripped: the note saying WHICH approximation was removed, and why, is
      // the record of the decision and has to stay readable.
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.ok(!/1\.96/.test(src), `${f}.js still carries a normal approximation`);
    assert.ok(!/function chanceBand/.test(src), `${f}.js declares its own chanceBand`);
  }
  assert.match(CRITERION, /exact binomial/);
  assert.match(CRITERION, /six closes/);
  assert.ok(!/1\.96|sqrt|square root/i.test(CRITERION));
});

test('the card carries evidence, never a score or a purchase', () => {
  const text = wiredText(get('copy-main'));
  for (const banned of ['Copy Score', 'Copy score', '/100', 'out of 100', 'Smart money',
    'Account value', 'Portfolio value', 'Sharpe', 'ROI 30D']) {
    assert.ok(!text.includes(banned), `"${banned}" appeared outside an unwired slot`);
  }
  // The score slot stays, and says what it needs: the feature is coming, and a gap that is
  // visible is the point.
  const scoreSlots = slots(get('copy-main')).filter((/** @type {any} */ s) => s.dataset.metric === 'copyScore');
  assert.ok(scoreSlots.length >= cards().length, 'the copy-score slot is missing from cards');
  for (const s of scoreSlots) {
    assert.ok(!/[$%]|\d[.,]\d/.test(s.textContent), `the slot carries a figure: ${s.textContent}`);
    assert.match(s.textContent, /definition|execution/i);
  }
});

test('the hero says what this page is, not what it will be', () => {
  const hero = byClass(get('copy-main'), 'hero-text')[0].textContent;
  assert.ok(!/autopilot|in real time|copied to your wallet/i.test(hero), `the hero claims execution: ${hero}`);
  assert.match(hero, /not live yet|nothing is placed/i, 'the hero does not say copying is not live');
});

test('the sparkline splits at zero rather than colouring by the final value', async () => {
  const { sparkline } = await import('../web/lib/spark.js');
  const svg = /** @type {any} */ (sparkline([[0, -4], [1, -9], [2, 2], [3, 7]], { width: 100, height: 40 }));
  const all = svg.descendants();
  const strokes = all.map((/** @type {any} */ n) => n.attributes.stroke).filter(Boolean);
  const fills = all.map((/** @type {any} */ n) => n.attributes.fill).filter(Boolean);
  assert.ok(strokes.includes('var(--up)') && strokes.includes('var(--down)'),
    'a run that dips negative is drawn in one colour');
  assert.ok(fills.includes('var(--up-bg)') && fills.includes('var(--down-bg)'));
  assert.equal(all.filter((/** @type {any} */ n) => n.attributes['clip-path']).length, 4,
    'fill and stroke are not both split at zero');
  // Two charts on a page must not share clip ids: the second would clip the first.
  const idOf = (/** @type {any} */ s) => s.descendants()
    .filter((/** @type {any} */ n) => n.tag === 'clipPath')[0].attributes.id;
  assert.notEqual(idOf(svg), idOf(/** @type {any} */ (sparkline([[0, -1], [1, 1]], {}))));
});

test('the setup window ends where the backend does', async () => {
  const card = cards()[0];
  const copyBtn = byClass(card, 'btn-copy')[0];
  assert.match(copyBtn.textContent, /Set up copy/);
  copyBtn.onclick?.({});
  await new Promise((r) => { setTimeout(r, 300); });

  const doc = /** @type {any} */ (globalThis.document);
  const panel = doc.getElementById('wz-panel') ?? byClass(doc.getElementById('copy-main') ?? { descendants: () => [] }, 'wz-panel')[0];
  void panel;
  // The dialog mounts on document.body, which the stub does not keep; what this test can
  // assert is the source contract, which is the part that must not drift: Confirm shows the
  // request it WOULD send and names the endpoint it is waiting for, and nothing is sent.
  const src = await readFile(new URL('../web/lib/copy-setup.js', import.meta.url), 'utf8');
  assert.match(src, /Nothing has been placed/);
  assert.match(src, /POST \/api\/copy-trade/);
  assert.ok(!/\bfetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'the wizard sends something');
  assert.match(src, /has been copied, countered, or simulated/i);
});

test('a logo goes where the ticker is written, and a letter where it is not', () => {
  /*
   * The card head stacks three 22px chips overlapping by 6px and writes no ticker beside
   * them, so the letter on each chip is the only thing naming that token. Logos were drawn
   * over exactly those letters for a pass: cropped artwork, no ticker, and — because the
   * address was wrapping — a chip sitting on top of the address line. CopyTrade.dc.html
   * draws a letter in every one of these. The logo belongs on the market rows, the asset
   * header and the holdings rows, where the ticker is written next to it.
   */
  const chips = byClass(get('copy-main'), 'ct-token-tile');
  assert.ok(chips.length > 5, 'the cards carry no token chips');
  for (const chip of chips) {
    assert.equal(chip.descendants().filter((/** @type {any} */ n) => n.tag === 'img').length, 0,
      'a logo is drawn over a chip that nothing names');
    assert.equal(chip.textContent.length, 1, `a stacked chip carries ${chip.textContent}`);
  }
  // And the head does not wrap: one line, one row of chips, inside 58px.
  const addr = byClass(get('copy-main'), 'ct-card-addr')[0];
  assert.ok(!/\n/.test(addr.textContent) && addr.textContent.length <= 14,
    `the address line is ${addr.textContent}`);
});

test('a card opens the trader, and the frame\'s foot is the frame\'s foot', async () => {
  /*
   * THE BUG THIS EXISTS FOR. The card's open control was a transparent button stretched
   * across the card at z-index 0, with the head, body and foot painted over it at z-index 1.
   * Every real click landed on the content and stopped there: the cards on /copy-trade opened
   * nothing at all for a whole release. It passed every test, because a test clicks the
   * element it looked up — `openBtn.onclick()` — and never asks the browser what is on top.
   *
   * So this pins the STRUCTURE the frame uses, which is what made it work: the head and the
   * body are inside the button, and nothing else is.
   */
  const card = cards()[0];
  const open = byClass(card, 'ct-card-open')[0];
  assert.ok(open, 'the card has no open control');
  assert.equal(open.tag, 'button');
  assert.ok(byClass(open, 'ct-card-head').length === 1 && byClass(open, 'ct-card-body').length === 1,
    'the head and body are not inside the open button, so a click on them does nothing');
  assert.equal(byClass(open, 'ct-card-foot').length, 0, 'the foot is inside the open button');
  assert.equal(open.descendants().filter((/** @type {any} */ n) => n.tag === 'button').length, 0,
    'a button nested inside the open button');

  // CopyTrade.dc.html's foot: the score treatment on the left, the button hard right.
  const foot = byClass(card, 'ct-card-foot')[0];
  const score = byClass(foot, 'ct-score')[0];
  assert.ok(score, 'the score slot is not in the foot');
  assert.equal(byClass(score, 'ct-score-bars')[0].children.length, 10, 'the frame draws ten bars');
  assert.equal(byClass(score, 'ct-score-value')[0].textContent, '—', 'a score appeared');
  assert.match(score.className, /\bunwired\b/, 'the score slot is not marked unwired');
  assert.ok(byClass(foot, 'btn-copy').length === 1, 'the Copy button left the foot');
});
