/**
 * The traders page: the reference's copytrading layout, filled with what we have.
 *
 * The load-bearing assertions here are about what is NOT on it. The reference's card
 * ends in a 0-100 Copy Score and a Copytrade button; we have no score and no execution,
 * and the tests below fail if either ever appears — a fabricated score is the exact
 * failure mode this project refuses, and a copy button with nothing behind it is worse.
 *
 * The wallet is connect-only, and that is pinned by asserting which RPC methods the page
 * is capable of asking for. A signature request would pass a render test happily.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { install } from './dom-stub.mjs';
import { chanceBand } from '../web/lib/evidence.js';

const { get } = await install(new URL('../web/traders.html', import.meta.url));
await import('../web/traders.js');

const board = JSON.parse(
  await readFile(new URL('../web/data/leaderboard/rwa-usdg-7d.json', import.meta.url), 'utf8'),
);

const cards = () => get('grid').byClass('tcard');

test('the coin-flip band is the published criterion, and small samples answer themselves', () => {
  // One lucky trade can never read as skill: the band covers the whole range.
  const one = chanceBand(1, 1);
  assert.equal(one.verdict, 'none');
  assert.equal(one.decisive, false);

  // 37 closes at 83.8% is outside 0.5 +/- 1.96*sqrt(0.25/37) = 0.339..0.661.
  const real = chanceBand(31, 37);
  assert.equal(real.verdict, 'above');
  assert.ok(Math.abs(real.lo - 0.3389) < 0.001 && Math.abs(real.hi - 0.6611) < 0.001,
    `band moved: ${real.lo} ${real.hi}`);

  // The band is symmetric about a coin flip, and losing streaks are called too.
  const bad = chanceBand(6, 37);
  assert.equal(bad.verdict, 'below');
  assert.equal(chanceBand(19, 37).verdict, 'within');

  // It narrows with n, which is the whole point of showing n beside it.
  assert.ok(chanceBand(60, 100).hi < chanceBand(6, 10).hi);
  assert.equal(chanceBand(0, 0).verdict, 'none');
});

test('the grid renders cards in the reference shape', () => {
  assert.equal(cards().length, 24, 'the first page is not a full 6x4 grid');
  for (const c of cards()) {
    assert.equal(c.byClass('avatar').length, 1);
    assert.ok(c.byClass('tcard-ago')[0].textContent.length > 0, 'no elapsed time on a card');
    assert.equal(c.byTag('svg').length, 1, 'a card has no sparkline');
    assert.equal(c.byClass('tcard-bar').length, 1, 'a card has no bottom bar');
    assert.equal(c.byClass('ev-track').length, 1, 'a card has no evidence track');
    assert.equal(c.byClass('ev-cta').length, 1, 'a card has no action');
  }
});

test('the bottom bar holds evidence, never a score or a purchase', () => {
  const text = get('grid').textContent;
  for (const banned of ['Copy Score', 'Copytrade', 'Copy score', '/100', 'Smart money']) {
    assert.ok(!text.includes(banned), `"${banned}" appeared on a card`);
  }
  // Every card's verdict is one of the four the criterion defines, spelled out in words.
  const labels = cards().map((/** @type {any} */ c) => c.byClass('ev-label')[0].textContent);
  const allowed = [/^Beyond chance$/, /^Within chance$/, /^Below chance$/, /^Too few closes to tell \(\d+\)$/];
  for (const l of labels) {
    assert.ok(allowed.some((re) => re.test(l)), `unexpected verdict wording: ${l}`);
  }
  assert.equal(cards()[0].byClass('ev-cta')[0].textContent, 'View trades');
});

test('the bar draws the band the data implies, not a fixed decoration', () => {
  for (const c of cards().slice(0, 8)) {
    const addr = c.attributes['aria-label'].replace('Open ', '');
    const row = board.rows.find((/** @type {any} */ r) => r.address === addr);
    const b = chanceBand(row.wins, row.round_trips);
    const band = c.byClass('ev-band')[0];
    const mark = c.byClass('ev-mark')[0];
    assert.equal(band.style.left, `${b.lo * 100}%`);
    assert.equal(mark.style.left, `${b.rate * 100}%`);
    // The tint reports the test result rather than the size of the number beside it.
    assert.ok(c.byClass('tcard-bar')[0].className.includes(`v-${b.verdict}`));
  }
});

test('card sparklines split at zero rather than colouring by the final value', async () => {
  const { sparkline } = await import('../web/lib/spark.js');
  const svg = /** @type {any} */ (sparkline([-4, -9, 2, 7], { width: 100, height: 40 }));
  const all = svg.descendants();
  const fills = all.map((/** @type {any} */ n) => n.attributes.fill).filter(Boolean);
  const strokes = all.map((/** @type {any} */ n) => n.attributes.stroke).filter(Boolean);
  assert.ok(fills.includes('var(--up-fill)') && fills.includes('var(--down-fill)'),
    'a run that dips negative is drawn in one colour');
  assert.ok(strokes.includes('var(--up)') && strokes.includes('var(--down)'));
  assert.equal(all.filter((/** @type {any} */ n) => n.attributes['clip-path']).length, 4);

  const second = /** @type {any} */ (sparkline([-1, 1], {}));
  const idOf = (/** @type {any} */ s) => s.descendants()
    .filter((/** @type {any} */ n) => n.tag === 'clipPath')[0].attributes.id;
  assert.notEqual(idOf(svg), idOf(second), 'two sparklines on a page share clip ids');
});

test('presets and filters change the set, and the caveat states the criterion', () => {
  const tabs = get('presets').byTag('button');
  assert.deepEqual(tabs.map((/** @type {any} */ b) => b.textContent),
    ['Top 100', 'Beyond chance', 'Most active', 'Best on volume', 'Traded last']);

  const before = cards().map((/** @type {any} */ c) => c.attributes['aria-label']);
  tabs[1].onclick?.(/** @type {any} */ ({}));
  const after = cards();
  assert.ok(after.length > 0, 'the beyond-chance preset emptied the grid');
  for (const c of after) {
    assert.equal(c.byClass('ev-label')[0].textContent, 'Beyond chance',
      'the preset let through a record that is not beyond chance');
  }
  assert.notDeepEqual(after.map((/** @type {any} */ c) => c.attributes['aria-label']), before);
  tabs[0].onclick?.(/** @type {any} */ ({}));

  // Scope stays above the ranking. The method behind the bar moved into a disclosure
  // beside the filter that uses it, rather than a paragraph between filters and cards.
  const caveat = get('caveat').textContent;
  assert.match(caveat, /closed a round-trip/i);
  assert.match(caveat, /out of scope, not estimated/);
  assert.ok(caveat.length < 220, `the caveat is a wall again: ${caveat.length} chars`);

  const criterion = get('criterion').textContent;
  assert.match(criterion, /coin-flip null/);
  assert.match(criterion, /It measures the rate, not the profit\./);
});

test('the page says there is no execution rather than implying there is', () => {
  const foot = get('footnote').textContent;
  assert.match(foot, /no execution here and no trade is copied/i);
  assert.match(foot, /end of the tape, not from now/);
});

test('the wallet asks for addresses and nothing else', async () => {
  const { mountWallet } = await import('../web/lib/wallet-ui.js');
  /** @type {string[]} */
  const asked = [];
  const provider = {
    /** @param {{method: string}} req */
    async request(req) {
      asked.push(req.method);
      return ['0x24E7A8963C07Dc0AD58098172ab2b9826bc90FB2'];
    },
  };
  /** @type {string[]} */
  const opened = [];
  const host = /** @type {any} */ (get('wallet'));
  mountWallet(host, {
    discover: async () => [{ info: { uuid: 'x', name: 'Test', icon: '', rdns: 't' }, provider }],
    hasDetail: async () => true,
    open: async (/** @type {string} */ a) => { opened.push(a); },
  });

  await host.byClass('wallet-btn')[0].onclick?.(/** @type {any} */ ({}));
  await new Promise((r) => { setTimeout(r, 0); });

  // Connect only. A signature or a transaction would pass a render test happily.
  assert.deepEqual(asked, ['eth_requestAccounts']);
  for (const method of ['personal_sign', 'eth_sign', 'eth_signTypedData_v4',
    'eth_sendTransaction', 'wallet_switchEthereumChain']) {
    assert.ok(!asked.includes(method), `the page asked for ${method}`);
  }

  // A checksummed address from the wallet has to be lowercased to find its file.
  assert.ok(host.textContent.includes('0x24E7…0FB2') || host.textContent.includes('0x24e7…0fb2'));
  const mine = host.byClass('wallet-btn').find((/** @type {any} */ b) => b.textContent === 'Your page');
  assert.ok(mine, 'a known address got no way into its own page');
  await mine.onclick?.(/** @type {any} */ ({}));
  assert.deepEqual(opened, ['0x24e7a8963c07dc0ad58098172ab2b9826bc90fb2']);
});

test('an address with no record is told so, not shown an empty page', async () => {
  const { mountWallet } = await import('../web/lib/wallet-ui.js');
  const host = /** @type {any} */ (get('wallet'));
  mountWallet(host, {
    discover: async () => [{ info: { uuid: 'x', name: 'Test', icon: '', rdns: 't' },
      provider: { async request() { return ['0x' + 'ab'.repeat(20)]; } } }],
    hasDetail: async () => false,
    open: async () => {},
  });
  await host.byClass('wallet-btn')[0].onclick?.(/** @type {any} */ ({}));
  await new Promise((r) => { setTimeout(r, 0); });
  assert.equal(host.byClass('wallet-note')[0].textContent, 'Not in this tape');
  assert.equal(host.byClass('wallet-btn').length, 0, 'an unknown address was offered a page');
});

test('a refused wallet prompt is a refusal, not a connection', async () => {
  const { connect } = await import('../web/lib/wallet.js');
  // Providers resolve with an empty list when the visitor dismisses the prompt.
  await assert.rejects(() => connect({ async request() { return []; } }), /no account authorised/);
  await assert.rejects(() => connect({ async request() { return ['not-an-address']; } }),
    /no account authorised/);
  await assert.rejects(() => connect(null), /no wallet provider/);
});

test('the modal closes three ways and hands focus back', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  const doc = /** @type {any} */ (globalThis.document);
  const card = /** @type {any} */ (get('grid').byClass('tcard')[0]);
  const modal = get('modal');

  // 1. The close button. It has to be reachable AND look like a control.
  await openDetail(board.rows[0].address, card);
  assert.equal(modal.hidden, false);
  assert.equal(doc.activeElement, get('modal-close'),
    'opening the dialog left focus outside it');
  get('modal-close').dispatchEvent({ type: 'click' });
  assert.equal(modal.hidden, true, 'the close button did not close the dialog');
  assert.equal(doc.activeElement, card, 'focus was not returned to the card that opened it');

  // 2. Escape.
  await openDetail(board.rows[1].address, card);
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(modal.hidden, true, 'escape did not close the dialog');
  assert.equal(doc.activeElement, card);

  // 3. The backdrop — but only the backdrop.
  await openDetail(board.rows[2].address, card);
  get('rail').dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(modal.hidden, false, 'a click inside the dialog closed it');
  modal.dispatchEvent({ type: 'click' });
  assert.equal(modal.hidden, true, 'the backdrop did not close the dialog');
  assert.equal(doc.activeElement, card);
});

test('escape does nothing while the dialog is already closed', async () => {
  const doc = /** @type {any} */ (globalThis.document);
  const before = doc.activeElement;
  assert.equal(get('modal').hidden, true);
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(doc.activeElement, before, 'a stray escape moved focus');
});

test('tab is trapped inside the dialog', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  const doc = /** @type {any} */ (globalThis.document);
  const card = /** @type {any} */ (get('grid').byClass('tcard')[0]);
  await openDetail(board.rows[0].address, card);

  const items = get('modal').querySelectorAll(
    'button, a[href], input, select, textarea, [tabindex]');
  assert.ok(items.length > 2, `the trap found ${items.length} focusable elements`);

  // Forward off the end wraps to the start; back off the start wraps to the end.
  items[items.length - 1].focus();
  doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.equal(doc.activeElement, items[0], 'tab escaped the dialog at the end');
  doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.equal(doc.activeElement, items[items.length - 1], 'shift-tab escaped at the start');

  get('modal-close').dispatchEvent({ type: 'click' });
});
