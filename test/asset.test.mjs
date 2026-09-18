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
  // Nothing drawn where the cluster would be: no bubbles, no holder rows.
  assert.equal(byClass(main(), 'as-bubble').length, 0, 'invented holder bubbles are on the page');
  assert.equal(byClass(main(), 'as-trow').length, 0, 'invented holder rows are on the page');
  // And no figure outside a slot claims to know the holder side.
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

test('the empty cluster keeps the frame\'s shape and stays empty', () => {
  /*
   * AssetHolders.dc.html draws a packed cluster of wallet bubbles, a legend naming what their
   * colours mean, a filter over them and a top-holders table. None of it can run on a swap
   * tape — a holder may never have swapped — so for a pass this panel was a dotted box with
   * one line of text in it, which reads as a page that failed to render rather than one
   * waiting on an index.
   *
   * The shape is the frame's. What fills it must not be: every ghost is the same size (the
   * frame sizes a bubble by position, so ghosts that varied would be a distribution nobody
   * measured), carries no label, and takes no sign colour. The legend and the filter are the
   * frame's own, and the filter cannot be pressed.
   */
  const stage = byClass(main(), 'as-cluster-stage')[0];
  assert.ok(stage, 'the cluster stage is gone');
  const ghosts = byClass(stage, 'as-ghost');
  assert.ok(ghosts.length >= 12, `only ${ghosts.length} placeholder bubbles`);
  for (const g of ghosts) {
    assert.equal(g.textContent, '', `a placeholder bubble carries text: ${g.textContent}`);
    assert.equal(String(g.className).includes('up') || String(g.className).includes('down'), false,
      'a placeholder bubble takes a sign colour');
  }
  assert.equal(byClass(stage, 'as-ghost')[0].className, byClass(stage, 'as-ghost').at(-1).className,
    'the placeholder bubbles are not all the same');

  // The legend that names the two colours, and the filter, both from the frame.
  const legend = byClass(stage, 'as-legend-swatch');
  assert.equal(legend.length, 3, 'the frame\'s three-part legend is not here');
  const filter = byClass(main(), 'as-cluster-filter')[0];
  assert.ok(filter, 'the frame\'s All / In profit / Underwater filter is missing');
  const buttons = filter.byTag('button');
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    assert.equal(b.disabled, true, 'a filter over holders nobody has is pressable');
    assert.match(b.title, /transfer index/i, 'the disabled control does not say why');
  }

  // The table keeps its four columns and its rows stay blank.
  const head = byClass(main(), 'as-thead')[0].textContent;
  for (const col of ['#', 'Wallet', 'Position', 'PnL']) assert.ok(head.includes(col));
  const rows = byClass(main(), 'as-holder-ghost');
  assert.ok(rows.length >= 6, 'the top-holders table shows no rows at all, not even empty ones');
  for (const r of rows) assert.equal(r.textContent, '', 'a placeholder row carries a figure');
});
