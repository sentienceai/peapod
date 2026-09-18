/**
 * Markets: the page the "Markets" nav item used to not have.
 *
 * It pointed at /asset?symbol=TSLA — one asset, chosen in the navigation, with no way to
 * reach the other two hundred. This page reads /api/assets, which has existed since the
 * endpoints landed.
 *
 * WHAT IT MAY SHOW. Only what the swap tape measures: the last trade, the 24h change where
 * there is a trade to measure it from, volume, traders and trade counts. No holder count,
 * no market cap, no supply — all three need the transfer index, and a market cap from a
 * last trade times a supply nobody read would be two guesses multiplied together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { byClass, openPage, placeholders, signChannels } from './page.mjs';

const { get } = await openPage('markets', 'markets-page');

/** The endpoint's own answer, to check the page against. */
async function endpoint() {
  const { Api, route } = await import('../web-api.mjs');
  const { fileURLToPath } = await import('node:url');
  const { gunzipSync } = await import('node:zlib');
  const api = new Api(process.env.PEAPOD_DB || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));
  try {
    const out = /** @type {any} */ (route(api, new URL('http://x/api/assets')));
    if (out.status !== 200) return [];
    return JSON.parse(out.gzip ? gunzipSync(Buffer.from(out.body)).toString('utf8') : String(out.body));
  } finally {
    api.close();
  }
}

test('every token the build ships is reachable from here', async () => {
  const list = await endpoint();
  assert.ok(list.length > 50, `the store lists only ${list.length} assets`);
  const rows = byClass(get('rows'), 'mk-row');
  assert.ok(rows.length > 0, 'no market rows rendered');
  // Richest first, which is what the endpoint orders by and what the page opens on.
  const first = byClass(rows[0], 'mk-sym')[0].textContent;
  const richest = [...list].sort((/** @type {any} */ a, /** @type {any} */ b) => b.volume24h - a.volume24h)[0];
  assert.equal(first, richest.symbol, 'the first row is not the busiest token');
  // Every row opens its own asset page, and the link is built for the symbol as stored —
  // three tokens on this tape are named in emoji or Chinese and have to survive the URL.
  for (const r of rows.slice(0, 12)) {
    const href = r.attributes.href;
    assert.match(href, /^\/asset\?symbol=/, `a row does not open an asset: ${href}`);
    const symbol = decodeURIComponent(href.replace('/asset?symbol=', ''));
    assert.ok(list.some((/** @type {any} */ a) => a.symbol === symbol),
      `${symbol} is linked but is not in the build`);
  }
});

test('the columns are the tape\'s, and the price says which price it is', () => {
  const head = get('thead').textContent;
  // "Price" alone is read as a market price. This is the last trade — an execution against
  // a pool — and on a thin token it can be hours old.
  assert.match(head, /Last trade/);
  assert.ok(!/\bPrice\b/.test(head), 'a column is called Price without saying which price');
  for (const col of ['24H volume', 'Traders', 'Trades']) {
    assert.ok(head.includes(col), `the ${col} column is gone`);
  }
  for (const banned of ['Holders', 'Market cap', 'Supply', 'In profit']) {
    assert.ok(!head.includes(banned), `${banned} needs the transfer index and cannot be a column`);
  }
  const note = get('note').textContent;
  assert.match(note, /not a mid and not a quote/);
  assert.match(note, /transfer index/);
});

test('a 24h change is signed three ways, and a missing one is not a zero', async () => {
  const wrong = signChannels(get('rows'));
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
  // A token that first traded inside the last day has nothing to measure a change from.
  // That is a dash, because zero would file it among the ones that did not move.
  const list = await endpoint();
  const missing = list.filter((/** @type {any} */ a) => a.change24h === null);
  for (const a of missing.slice(0, 3)) {
    const row = byClass(get('rows'), 'mk-row')
      .find((/** @type {any} */ r) => byClass(r, 'mk-sym')[0]?.textContent === a.symbol);
    if (!row) continue; // below the visible cut, which is fine
    assert.ok(byClass(row, 'mk-none').length === 1, `${a.symbol} shows a figure it does not have`);
  }
});

test('the tokens carry their logos here too', () => {
  // 433 vendored files cover about 99% of what gets displayed. A tile with no file draws
  // its initials — that is the fallback, not the norm, and a page where EVERY tile is
  // initials means the map never arrived.
  const rows = byClass(get('rows'), 'mk-row');
  const tiles = rows.flatMap((/** @type {any} */ r) => byClass(r, 'asset-tile'));
  const imgs = rows.flatMap((/** @type {any} */ r) => r.descendants()
    .filter((/** @type {any} */ n) => n.tag === 'img'));
  assert.ok(tiles.length > 10, `only ${tiles.length} tiles`);
  assert.ok(imgs.length / tiles.length > 0.9,
    `only ${imgs.length} of ${tiles.length} tiles have a logo`);
  for (const img of imgs.slice(0, 10)) {
    assert.match(img.attributes.src, /^\/token-logos\/0x[0-9a-f]{40}\.(png|jpg|jpeg|webp)$/);
    assert.equal(img.attributes.alt, '', 'the ticker is already text; the logo is decorative');
  }
});

test('the kind tabs filter, and say which is on', () => {
  const tabs = get('kinds').byTag('button');
  assert.deepEqual(tabs.map((/** @type {any} */ b) => b.textContent), ['All', 'Stocks', 'Memecoins']);
  assert.equal(tabs.filter((/** @type {any} */ b) => b.attributes['aria-pressed'] === 'true').length, 1);
  const before = byClass(get('rows'), 'mk-row').length;
  tabs[2].onclick?.({});
  const memes = byClass(get('rows'), 'mk-row');
  assert.ok(memes.length > 0 && memes.length <= before, 'the memecoin tab filtered nothing');
  for (const r of memes.slice(0, 8)) {
    assert.equal(byClass(r, 'mk-kind')[0].textContent, 'Memecoin', 'a stock survived the memecoin filter');
  }
  tabs[0].onclick?.({});
});

test('nothing in the table says "undefined"', () => {
  const junk = placeholders(get('rows'));
  assert.deepEqual(junk, [], `placeholders in the market rows:\n  ${junk.join('\n  ')}`);
});
