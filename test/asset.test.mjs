/**
 * The asset page: what the swap tape can answer, and what it cannot.
 *
 * The frame draws a holder cluster, a top-holders table, "IN PROFIT" and "AVG ENTRY". All
 * four need an ERC-20 transfer index — a holder may never have swapped, and most holdings
 * on this chain arrived by transfer, issuance or bridge — so the tape this page is built
 * from cannot see them at all. The build's own mock still invents them, which is exactly
 * the failure mode: a plausible cluster of wallets beside four measured figures.
 *
 * So this file pins the split. Price, 24h volume, the price series, the trader count and
 * the recent trades are measured and must come from the endpoint. Everything holder-shaped
 * is an unwired slot naming the transfer index, and must carry no number at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { byClass, openPage, signChannels, slots, wiredText } from './page.mjs';

const { get } = await openPage('asset', 'asset-page', { search: '?symbol=TSLA' });
const main = () => get('asset-main');

/** The endpoint's own answer, to check the page against. */
/** @param {string} symbol */
async function endpoint(symbol) {
  const { Api, route } = await import('../web-api.mjs');
  const { fileURLToPath } = await import('node:url');
  const { gunzipSync } = await import('node:zlib');
  const api = new Api(process.env.PEAPOD_DB || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));
  try {
    const out = /** @type {any} */ (route(api, new URL(`http://x/api/asset/${symbol}`)));
    if (out.status !== 200) return null;
    return JSON.parse(out.gzip ? gunzipSync(Buffer.from(out.body)).toString('utf8') : String(out.body));
  } finally {
    api.close();
  }
}

test('the measured figures are the endpoint\'s, to the digit', async () => {
  const d = await endpoint('TSLA');
  assert.ok(d, 'the store has no TSLA');
  const text = main().textContent;
  assert.ok(text.includes('TSLA'), 'the page is not about the symbol asked for');
  // 24h volume and the trader count, as the page compacts them.
  const { compact } = await import('../web/lib/format.js');
  assert.ok(text.includes(compact(d.asset.volume24h)), '24h volume is not the endpoint\'s');
  assert.ok(text.includes(Number(d.asset.traders).toLocaleString('en-US')),
    'the trader count is not the endpoint\'s');
  // The price series is drawn, not described.
  assert.ok(byClass(main(), 'chart-svg').length >= 1, 'the price chart is gone');
  // And the recent trades are the tape's, newest first.
  const rows = byClass(main(), 'as-trade-row');
  assert.ok(rows.length > 0, 'no recent trades rendered');
  assert.ok(rows.length <= d.trades.length, 'more trade rows than the endpoint returned');
});

test('every holder figure is a slot naming the transfer index, and carries no number', () => {
  const metrics = slots(main()).map((/** @type {any} */ s) => s.dataset.metric);
  for (const m of ['holders', 'inProfit', 'avgEntry']) {
    assert.ok(metrics.includes(m), `${m} is not a slot on this page`);
  }
  for (const s of slots(main())) {
    assert.match(s.textContent, /transfer index/i, `a slot does not say what it needs: ${s.textContent}`);
    assert.ok(!/[$%]|\d[.,]\d/.test(s.textContent), `a slot carries a figure: ${s.textContent}`);
  }
  // And no figure outside a slot claims to know the holder side. The cluster below draws
  // MEASURED positions, which is a different quantity and says so — see the cluster test.
  const text = wiredText(main());
  for (const banned of ['IN PROFIT', 'AVG ENTRY', 'HOLDERS', 'Top holders shown']) {
    assert.ok(!text.includes(banned), `"${banned}" appears as a measured figure`);
  }
});

test('the price says what it is: the last trade, not a mid or a quote', () => {
  /*
   * A price on this page is an execution — the last fill the tape holds against a pool —
   * and on a thin token it can be hours old and away from where the pool would fill now.
   * "Price" on its own is read as a market price, which is a different claim, so the page
   * says which one it is everywhere the figure appears.
   */
  const text = main().textContent;
  assert.match(text, /Last trade · not a mid or a quote/,
    'the header price does not say what kind of price it is');
  assert.match(text, /PRICE · LAST TRADE/, 'the chart label does not say what it plots');
});

test('the page does not claim to be live', () => {
  const text = main().textContent;
  assert.ok(!/live from/i.test(text), 'the page claims a live feed');
  // What it says instead: these came from the build, which is minutes old and fixed until
  // the next cycle.
  assert.match(text, /swap tape|current build/i);
});

test('signed figures on this page keep all three channels', () => {
  const wrong = signChannels(main());
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('a symbol the build does not carry is said, not faked', async () => {
  assert.equal(await endpoint('NOPE'), null, 'the endpoint invented an unknown symbol');
  // The page falls back to a symbol it has and says which one it was asked for, rather than
  // rendering an empty shell that looks like a real asset with no trades.
  const { default: src } = { default: await (await import('node:fs/promises'))
    .readFile(new URL('../web/lib/asset-page.js', import.meta.url), 'utf8') };
  assert.match(src, /isn't a symbol this build tracks/);
});

test('the tokens carry their logos, not just their initials', () => {
  /*
   * THE FAILURE THIS CATCHES. 433 logo files are vendored and the map covers almost every
   * token any page displays, and for a while every tile on the site drew two letters anyway:
   * the map was loaded by one page, and two pages built their tiles by hand instead of
   * calling the helper that adds the image. Initials are the FALLBACK for a token with no
   * file; a page where every tile is initials means the map never arrived.
   */
  const tiles = byClass(main(), 'asset-tile');
  const imgs = main().descendants().filter((/** @type {any} */ n) => n.tag === 'img');
  assert.ok(tiles.length > 0, 'no asset tiles rendered at all');
  assert.ok(imgs.length / tiles.length > 0.9,
    `only ${imgs.length} of ${tiles.length} tiles carry a logo`);
  for (const img of imgs.slice(0, 8)) {
    // Only a filename this build produced ever reaches a URL.
    assert.match(img.attributes.src, /^\/token-logos\/0x[0-9a-f]{40}\.(png|jpg|jpeg|webp)$/);
    assert.equal(img.attributes.alt, '', 'the ticker is already text; the logo is decorative');
  }
});

test('the cluster is measured positions, and never called holders', async () => {
  /*
   * WHAT THIS PANEL MAY CLAIM. The build folds the swap tape into a net position per wallet:
   * units bought on-chain minus units sold, with a FIFO cost for what is left. That is a
   * floor on what those wallets hold and it is not a holder list — a wallet can be handed
   * units by transfer, bridge or issuance, and a swap tape cannot see any of it. The panel
   * says so in its own words, the figures come from the endpoint, and the three all-holder
   * figures in the header stay unwired.
   */
  const d = await endpoint('TSLA');
  const positions = d.positions ?? [];
  assert.ok(positions.length > 8, `the build shipped ${positions.length} positions`);

  const bubbles = byClass(main(), 'as-bubble');
  assert.equal(bubbles.length, positions.length, 'the cluster is not drawing what the build measured');
  const addresses = new Set(positions.map((/** @type {any} */ p) => p.address));
  for (const b of bubbles) {
    const said = b.attributes['aria-label'];
    const head = /0x[0-9a-f]{4}/.exec(said)?.[0];
    assert.ok([...addresses].some((/** @type {any} */ a) => a.startsWith(head)),
      `a bubble names an address the build did not measure: ${said}`);
  }

  // Every row is a position from the endpoint, in its order, with its own figures.
  const rows = byClass(main(), 'as-trow');
  assert.equal(rows.length, positions.length);
  const { compact } = await import('../web/lib/format.js');
  for (const [i, row] of rows.slice(0, 6).entries()) {
    const p = positions[i];
    assert.ok(row.textContent.includes(compact(p.value)),
      `row ${i + 1} does not carry the endpoint's position: ${row.textContent}`);
    if (Number.isFinite(p.pnl_pct)) {
      const mag = Math.abs(p.pnl_pct);
      assert.ok(row.textContent.includes(`${mag < 0.1 ? mag.toFixed(2) : mag.toFixed(1)}%`),
        `row ${i + 1} does not carry the endpoint's cost comparison: ${row.textContent}`);
    }
  }

  // The words. "Holder" is what this is NOT, and the panel has to say which.
  const text = wiredText(main());
  assert.match(text, /bought .* on-chain/i, 'the panel does not say where these positions come from');
  assert.match(text, /transferred or bridged in are invisible/i,
    'the panel does not say what it cannot see');
  assert.ok(!/Holder cluster|Top holders/i.test(text),
    'the panel still calls measured positions holders');
  // And the all-holder figures are still slots.
  const metrics = slots(main()).map((/** @type {any} */ x) => x.dataset.metric);
  for (const m of ['holders', 'inProfit', 'avgEntry']) assert.ok(metrics.includes(m));
});

test('the filter over the cluster is live, and names both directions', async () => {
  const seg = byClass(main(), 'as-cluster-filter')[0];
  assert.ok(seg, 'the frame\'s filter is missing');
  const buttons = seg.byTag('button');
  assert.deepEqual(buttons.map((/** @type {any} */ b) => b.textContent), ['All', 'In profit', 'Underwater']);
  for (const b of buttons) assert.equal(b.disabled, false, 'the filter is inert over data that exists');
  /*
   * How many bubbles SHOULD dim is a property of the build, not a constant: on a token
   * where every measured position happens to be above its cost, filtering to "in profit"
   * correctly dims nothing. So the expected count comes from the endpoint.
   */
  const d = await endpoint('TSLA');
  const under = (d.positions ?? []).filter((/** @type {any} */ p) => Number.isFinite(p.pnl_pct) && p.pnl_pct < 0);
  const lit = () => byClass(main(), 'as-bubble')
    .filter((/** @type {any} */ b) => b.attributes.opacity !== '0.18').length;
  const all = lit();
  buttons[1].onclick?.({});
  assert.equal(lit(), all - under.length,
    `filtering to "in profit" dimmed ${all - lit()} of the ${under.length} positions below cost`);
  buttons[2].onclick?.({});
  assert.equal(lit(), under.length, 'filtering to "underwater" left the wrong bubbles lit');
  buttons[0].onclick?.({});
  assert.equal(lit(), all, 'going back to "all" did not light them all again');
  // The legend is the key to the two colours and the ring, all three of them.
  const legend = byClass(main(), 'as-legend-swatch');
  assert.equal(legend.length, 3);
});
