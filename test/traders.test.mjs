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
import { index, sample, view } from './store.mjs';
import * as chromeMod from '../web/lib/chrome.js';
import { chanceBand } from '../web/lib/evidence.js';

const { get } = await install(new URL('../web/traders.html', import.meta.url));
await import('../web/traders.js');

const board = view('all', '7d');

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

test('the scope tabs are offered and the caveat states scope before ranking', () => {
  const cats = get('categories').byTag('button');
  assert.deepEqual(cats.map((/** @type {any} */ b) => b.textContent), ['All', 'RWA', 'Pons']);
  const quotes = get('quotes').byTag('button');
  assert.deepEqual(quotes.map((/** @type {any} */ b) => b.textContent), ['All', 'USDG', 'ETH']);

  // Scope stays above the ranking. The method behind the bar moved into a disclosure
  // beside the filter that uses it, rather than a paragraph between filters and cards.
  const caveat = get('caveat').textContent;
  assert.match(caveat, /closed a round-trip/i);
  assert.match(caveat, /out of scope, not estimated/);
  // Both universes, both counts, the window, and how the dollars are made.
  assert.match(caveat, /tokenized-equity pools/);
  assert.match(caveat, /Pons pools/);
  assert.match(caveat, /ETH-quoted legs convert at the trade's own timestamp/);
  // It lives in the hero now, above the controls. What it must not become again is a
  // paragraph between the filters and the cards, so it stays bounded.
  assert.ok(caveat.length < 520, `the caveat is a wall again: ${caveat.length} chars`);

  const criterion = get('criterion').textContent;
  assert.match(criterion, /coin-flip null/);
  assert.match(criterion, /the rate, not the profit/);
  // The test only sees selling with an on-chain buy behind it. The criterion has to say
  // so, and has to say the subset was checked for selection rather than assumed clean.
  assert.match(criterion, /only the selling that has an on-chain buy/);
  assert.match(criterion, /Checked for selection/);
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

test('the badge says how much of an address it can actually see', async () => {
  const { coverage } = await import('../web/lib/evidence.js');
  // 72% of selling chain-wide has no on-chain buy, so a badge over 12% of one address's
  // flow and a badge over 95% of it are different claims and must not look alike.
  assert.equal(coverage(0, 100), 100);
  assert.equal(coverage(100, 100), 0);
  assert.equal(coverage(25, 100), 75);
  assert.equal(coverage(5, 0), 0, 'a zero-volume address must not divide by zero');
  assert.equal(coverage(150, 100), 0, 'coverage must not go negative');

  for (const c of get('grid').byClass('tcard').slice(0, 8)) {
    const addr = c.attributes['aria-label'].replace('Open ', '');
    const row = board.rows.find((/** @type {any} */ r) => r.address === addr);
    const shown = c.byClass('ev-n').map((/** @type {any} */ n) => n.textContent);
    const want = `${coverage(row.out_of_scope_volume, row.total_volume).toFixed(0)}% covered`;
    assert.ok(shown.includes(want),
      `card shows ${JSON.stringify(shown)}, expected ${want}`);
    assert.ok(shown.includes(`${row.round_trips} closed`));
  }
});

test('the card bar cannot be squeezed by the content above it', async () => {
  const css = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
  const bar = css.slice(css.indexOf('.tcard-bar {'), css.indexOf('.tcard-bar.v-above'));
  // The bar is a flex item in a column with a min-height. Without flex:none it is the
  // thing that shrinks when head + body overflow, and overflow:hidden then clips it.
  assert.match(bar, /flex:\s*none/, 'the bottom bar can still be squashed and clipped');
  assert.match(bar, /height:\s*46px/);
  const head = css.slice(css.indexOf('.tcard-head {'), css.indexOf('.tcard-who'));
  assert.match(head, /flex:\s*none/, 'the header can still be squashed');
});

test('the deck never drives the hero height, and is all three cards or none', async () => {
  const css = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
  const deck = css.slice(css.indexOf('.hero-deck {'), css.indexOf('.deckcard {'));
  // In the grid it set the row height even when the text was shorter, and the 57px gap
  // was then measured below the deck rather than below the last line of text.
  assert.match(deck, /position:\s*absolute/, 'the deck is back in flow and will pad the hero');
  const hero = css.slice(css.indexOf('.hero {'), css.indexOf('.hero h1'));
  assert.ok(!/grid-template-columns/.test(hero), 'the hero is a grid again');

  const deckEl = get('hero-deck');
  assert.equal(deckEl.hidden, false);
  assert.equal(deckEl.byClass('deckcard').length, 3, 'a partial stack reads as a failure');
});

test('a scope refolds the matching rather than filtering rows', async () => {
  // 68 of the top 100 trade BOTH universes. If a scope filtered rows, the Pons table
  // would still show those addresses carrying the profit they made on RWA. Each scope is
  // its own build, so the same address has DIFFERENT numbers under different scopes.
  const all = view('all', '7d');
  const rwa = view('rwa', '7d');
  const pons = view('pons', '7d');

  const byAddr = (/** @type {any} */ b) => new Map(
    b.rows.map((/** @type {any} */ r) => [r.address, r]));
  const A = byAddr(all); const R = byAddr(rwa); const P = byAddr(pons);
  const inBoth = [...A.keys()].filter((a) => R.has(a) && P.has(a));
  assert.ok(inBoth.length > 20, `only ${inBoth.length} addresses appear in both scopes`);
  for (const a of inBoth.slice(0, 25)) {
    assert.notEqual(A.get(a).realized, R.get(a).realized,
      `${a} has identical PnL under All and RWA — the scope filtered rows`);
    assert.ok(R.get(a).round_trips < A.get(a).round_trips,
      `${a} kept all its round-trips under the RWA scope`);
  }
  // RWA pools all quote USDG, so an rwa-eth scope would be empty and is not built.
  const idx = index();
  assert.equal(idx.views.filter((/** @type {any} */ v) => v.scope === 'rwa-eth').length, 0);
  assert.ok(pons.coverage.universe.includes('Pons'));
  assert.ok(rwa.coverage.universe.includes('tokenized-equity'));
});

test('the RWA tab says its success rate is small magnitudes, not better trading', async () => {
  const rwa = view('rwa', '7d');
  const all = view('all', '7d');
  // The thing that needs saying: RWA is in profit far more often, on a ceiling two orders
  // of magnitude lower. Without the note it reads as the safer place to trade.
  assert.ok(rwa.distribution.in_profit_pct > all.distribution.in_profit_pct + 10);
  assert.ok(rwa.distribution.percentiles['100'] < all.distribution.percentiles['100'] / 50);
  const note = rwa.coverage.magnitude_note;
  assert.ok(note, 'the RWA scope ships no magnitude note');
  assert.match(note, /reflects how little is at stake, not better trading/);
  assert.ok(!all.coverage.magnitude_note, 'the All scope should not carry the RWA note');
});

test('the distribution is on the page, above the ranking', async () => {
  const stats = get('dist').byClass('dstat');
  assert.ok(stats.length >= 4, 'the field distribution is not rendered');
  const text = get('dist').textContent;
  const d = board.distribution;
  assert.ok(text.includes('Median'), 'the median is not shown');
  assert.ok(text.includes(`${d.in_profit_pct.toFixed(1)}%`), 'the in-profit rate is not shown');
  assert.ok(text.includes(`${(d.top1pct_share * 100).toFixed(0)}%`),
    'the top-1% concentration is not shown');
  assert.ok(text.includes(d.at_a_loss.toLocaleString('en-US')),
    'how many lost money is not shown');
  // Half made under a dollar. That is the finding; the top row is an outlier.
  assert.ok(Math.abs(d.percentiles['50']) < 5, `median moved to ${d.percentiles['50']}`);
  assert.ok(d.top1pct_share > 0.4, 'top-1% concentration fell below the reported level');
});

test('the hero leads with the field, not with the best number', async () => {
  // The headline is static markup, so it is read from the file. The stub creates nodes
  // for id'd elements but does not carry their authored text.
  const html = await readFile(new URL('../web/traders.html', import.meta.url), 'utf8');
  const h1 = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'));
  const sub = get('hero-sub').textContent;
  assert.match(h1, /Every trader on the chain/);
  assert.ok(!/\$/.test(h1), 'the headline quotes a figure');
  assert.match(sub, /Half of those who closed a round-trip made under/);
  assert.match(sub, /top 1% took/);
  assert.match(sub, /no execution here/i);
});

test('an address detail carries its percentile and the field it is read against', async () => {
  const found = sample({ where: 'round_trips > 5', limit: 1 })[0];
  assert.ok(found, 'no qualifying address in the store');
  // A dollar figure alone does not say whether it beat anyone: the median qualifier made
  // under a dollar, so $40 is not a small result here.
  assert.equal(typeof found.summary.percentile, 'number');
  assert.ok(found.summary.percentile >= 0 && found.summary.percentile <= 100);
  assert.ok(found.field.qualifying > 1000, 'the field context is missing');
  assert.ok(found.field.at_a_loss_pct > 0, 'the loss context is missing');
  // Which universes this address traded is a fact about it, not a grid category.
  assert.ok(Array.isArray(found.universes) && found.universes.length > 0);
  for (const u of found.universes) assert.ok(['rwa', 'pons'].includes(u));
});

test('the API is the contract, and it is read-only', async () => {
  const { Api, route: rawRoute } = await import('../web-api.mjs');
  /** @param {any} a @param {URL} u */
  const route = (a, u) => /** @type {any} */ (rawRoute(a, u)) ?? { status: 0 };
  const { fileURLToPath } = await import('node:url');
  const api = new Api(process.env.PEAPOD_DB
    || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));

  // Every route a page uses, answered from the store.
  assert.equal(route(api, new URL('http://x/api/manifest')).status, 200);
  assert.equal(route(api, new URL('http://x/api/leaderboard/index')).status, 200);
  assert.equal(route(api, new URL('http://x/api/leaderboard/all/7d')).status, 200);
  const one = /** @type {any} */ (route(api, new URL(`http://x/api/address/${board.rows[0].address}`)));
  assert.equal(one.status, 200);
  assert.equal(one.gzip, true, 'payloads must go out compressed, as stored');

  // Absent is a real answer: most addresses on this chain never traded.
  assert.equal(route(api, new URL(`http://x/api/address/0x${'ab'.repeat(20)}`)).status, 404);
  // And nothing that is not an address reaches a query.
  // Anything that is not exactly 40 lowercase hex characters after 0x never reaches a
  // query. A traversal attempt is normalised out of the path by URL before the API sees
  // it, so what has to hold here is the shape check.
  for (const bad of ['0xzz', 'select', '0x1234', "0x' OR 1=1--", '0xABCDEF']) {
    assert.equal(route(api, new URL(`http://x/api/address/${encodeURIComponent(bad)}`))
      .status, 404, bad);
  }
  // Scope and window are matched against a strict name pattern before they reach a
  // query. A traversal attempt is normalised out of the path by URL itself and never
  // reaches the API at all, so the check that matters is the pattern.
  for (const bad of ['ALL', 'all;drop', 'all%20', '../etc']) {
    assert.equal(route(api, new URL(`http://x/api/leaderboard/${bad}/7d`)).status, 404, bad);
  }

  // There is no write route at all, which is what makes the dev proxy safe to point at
  // production: there is nothing to forward that could change anything.
  const src = await readFile(new URL('../web-api.mjs', import.meta.url), 'utf8');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ATTACH']) {
    assert.ok(!src.includes(verb), `the read API contains ${verb}`);
  }
  assert.match(src, /readOnly: true/);
  assert.match(src, /query_only=1/);
  api.close();
});

test('the manifest names the build, and the footer shows it', async () => {
  const manifest = await fetch('/api/manifest').then((r) => r.json());
  assert.match(manifest.build, /^\d{8}T\d{6}Z$/, `build id is ${manifest.build}`);
  assert.ok(manifest.addresses > 100000);
  assert.ok(manifest.qualifying > 0 && manifest.qualifying < manifest.addresses);
  // A proxied dev session must be able to say which build it is looking at, or a bug
  // report cannot name one.
  assert.ok(get('footnote').textContent.includes(manifest.build),
    'the footer does not name the build');
});

test('the dev server can run against a deployed store with no local data', async () => {
  // The tarball problem: 256 MB of database is not something to hand a collaborator, and
  // a stale copy is worse than none. PEAPOD_STORE points /api upstream and the site runs
  // unchanged, because the API is the contract and the page never knew where bytes lived.
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /PEAPOD_STORE/, 'the server has no remote-store mode');
  assert.match(src, /proxying \/api to/);

  // Read-only, and nothing of ours travels with the request: path and query, no headers,
  // no credentials, no cookies.
  // Slice the proxy function itself, not everything up to some later landmark: an
  // earlier version of this ran to `let buildCache` and started matching unrelated code
  // as soon as a function was inserted between them.
  const from = src.indexOf('async function proxy(');
  const proxyFn = src.slice(from, src.indexOf('\n}\n', from));
  assert.ok(!/headers:/.test(proxyFn), 'the proxy forwards headers upstream');
  assert.ok(!/GOLDSKY|API_KEY|Authorization/i.test(proxyFn));
  assert.match(proxyFn, /createHash/, 'proxied reads are not cached');
  // Keyed by upstream build, so the cache invalidates when the deployment moves rather
  // than going quietly stale.
  assert.match(proxyFn, /\$\{build\}\|/);
  // And re-compressed, so a proxied route behaves like a local one rather than sending
  // four times the bytes.
  assert.match(proxyFn, /gzipSync/);

  // With neither a store nor an upstream it SERVES AN EMPTY STATE and says so. It used
  // to exit, which on a fresh deploy meant the container restarted about once a second
  // and could never be attached to or seeded: it needed data to start and needed to
  // start to receive data.
  assert.match(src, /serving an empty state; the first cycle will fill it/);
  assert.ok(!/process\.exit\(1\)/.test(src), 'the server still exits when the store is missing');
  assert.match(src, /function emptyState/);
});

test('the search pill carries the shortcut its platform actually has', async () => {
  const { mountSearchShortcut } = await import('../web/lib/chrome.js');
  const cap = get('keycap');
  const input = get('search');

  mountSearchShortcut({ platform: 'Linux x86_64' });
  assert.equal(cap.textContent, 'Ctrl K',
    'a Linux visitor is being told to press a key they do not have');
  assert.equal(input.attributes['aria-keyshortcuts'], 'Control+K');

  mountSearchShortcut({ platform: 'MacIntel' });
  assert.equal(cap.textContent, '⌘K');
  assert.equal(input.attributes['aria-keyshortcuts'], 'Meta+K');

  const doc = /** @type {any} */ (globalThis.document);
  doc.activeElement = null;
  doc.dispatchEvent({ type: 'keydown', key: 'k', metaKey: true });
  assert.equal(doc.activeElement, input, 'the shortcut did not focus the field');
  // Escape gives the field back, which is the other half of a shortcut being usable.
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.notEqual(doc.activeElement, input);
});

test('the status bar says what build is being served, and nothing it cannot know', () => {
  const { renderStatusBar } = /** @type {any} */ (chromeMod);
  renderStatusBar({ build: '20260916T044645Z', addresses: 103920, qualifying: 30015 });
  const bar = get('statusbar');
  const text = bar.textContent;
  assert.match(text, /20260916T044645Z/, 'the bar does not name the build');
  assert.match(text, /103,920 addresses/);
  assert.match(text, /30,015 with a round-trip/);
  assert.equal(bar.byClass('status-dot')[0].className.includes('is-live'), true);

  // The reference puts a wallet balance and a live socket dot here. We have neither, and
  // an empty shell in the same shape advertises a feature that does not exist.
  for (const absent of ['$0.00', 'Copiers', 'Account Value', 'Copy Score', 'Sharpe']) {
    assert.ok(!text.includes(absent), `${absent} appeared in the status bar`);
  }

  // Before the first build it says so rather than showing a build id it has not got.
  renderStatusBar({ build: null, addresses: 0, qualifying: 0 });
  assert.match(get('statusbar').textContent, /No build yet/);
  assert.equal(get('statusbar').byClass('status-dot')[0].className.includes('is-empty'), true);
});

test('podium badges carry the rank as a numeral, not only as a colour', async () => {
  const { rankBadge } = /** @type {any} */ (chromeMod);
  for (const place of [1, 2, 3]) {
    const b = rankBadge(place);
    assert.equal(b.textContent, String(place),
      'the medal is colour-only, which is unreadable for a colourblind visitor');
    assert.ok(b.className.includes(`medal--${place}`));
    assert.equal(b.attributes['aria-label'], `Rank ${place}`);
  }
  // And the three are actually distinct classes, not one badge repeated.
  const classes = [1, 2, 3].map((p) => rankBadge(p).className);
  assert.equal(new Set(classes).size, 3);
});

test('token chips stack and the remainder is a count, not another chip', async () => {
  const { stackedChips } = /** @type {any} */ (chromeMod);
  /** @param {string} t */
  const chip = (t) => {
    const n = document.createElement('span');
    n.className = 'chip';
    n.textContent = t;
    return n;
  };
  const many = stackedChips(['A', 'B', 'C', 'D', 'E', 'F'], 9, chip);
  const items = many.byClass('chipstack-item');
  assert.equal(items.length, 4, 'the stack is not bounded');
  // The leftmost reads as the front of the set.
  assert.deepEqual(items.map((/** @type {any} */ n) => Number(n.style.zIndex)), [4, 3, 2, 1]);
  assert.equal(many.byClass('chipstack-more')[0].textContent, '+5');
  assert.equal(many.attributes['aria-label'], '9 tokens');

  const one = stackedChips(['A'], 1, chip);
  assert.equal(one.byClass('chipstack-more').length, 0);
  assert.equal(one.attributes['aria-label'], '1 token');
});

test('the components the data cannot support are still absent', async () => {
  // The spec describes Copy Score, a Copytrade CTA and its setup modal, Active Positions
  // with leverage and liquidation, Account Value, Sharpe, Max Drawdown and Copiers. None
  // of those exist here, and rebuilding them as empty shells would be worse than the gap.
  const page = get('grid').textContent + get('statusbar').textContent
    + get('caveat').textContent + get('footnote').textContent;
  for (const banned of ['Copy Score', 'Copytrade', 'Account Value', 'Sharpe',
    'Max Drawdown', 'Copiers', 'Liquidation', 'Leverage', '/100']) {
    assert.ok(!page.includes(banned), `"${banned}" appeared on the page`);
  }
  const css = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
  assert.ok(!/#09090B|#00E676|#FF5252|#00E5FF/i.test(css),
    'a colour from the reference palette leaked into the stylesheet');
});
