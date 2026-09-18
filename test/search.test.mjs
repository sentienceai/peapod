/**
 * The search palette, which is how anyone reaches a token or an address that is not on the
 * first page of whatever they are looking at.
 *
 * THE FAILURE THIS FILE EXISTS FOR. The palette opened on the Assets tab and stayed there.
 * Typing an address gave a header reading "Assets 0 · Traders 30" over an empty list and a
 * "No matches" line underneath: thirty hits, on a tab nobody was told to press. Every address
 * search in the build looked broken, and there was no test here at all — the palette was the
 * one piece of the frontend with no coverage, which is why it could be dead for a release.
 *
 * The second half is what it promises. The placeholder asked for "trader names" and token
 * names; /api/assets ships a symbol and a kind, and no address on this chain carries a label
 * this build can read. A field that asks for a name and answers every name with "no matches"
 * is a broken search, not an empty one, so it asks for what it can actually match.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { byClass, openPage } from './page.mjs';
import { sample } from './store.mjs';

// The palette lives on every page; it is opened here from the leaderboard because the
// stub keeps one document at a time and the board is the page that mounts fastest.
await openPage('leaderboard', 'board');
const { openSearch, closeSearch } = await import('../web/lib/search.js');
const doc = /** @type {any} */ (globalThis.document);

const panel = () => byClass(doc.body, 'search-panel')[0] ?? null;
const rows = () => byClass(panel(), 'search-row');
const input = () => panel().descendants().find((/** @type {any} */ n) => n.tag === 'input');

/** Type into the palette the way a keystroke does, and let the search settle. */
async function typeQuery(/** @type {string} */ q) {
  const field = input();
  field.value = q;
  field.oninput?.({ target: field });
  await new Promise((r) => { setTimeout(r, 400); });
}

const addr = sample({ where: 'round_trips > 0', limit: 1 })[0].address;

test('an address finds its traders without anyone pressing a tab', async () => {
  openSearch({});
  await new Promise((r) => { setTimeout(r, 100); });
  assert.ok(panel(), 'the palette did not open');
  await typeQuery(addr.slice(0, 6));
  assert.ok(rows().length > 0,
    'an address query rendered no rows — the palette is sitting on a tab with no hits');
  const tabs = byClass(panel(), 'search-tab');
  const on = tabs.filter((/** @type {any} */ t) => t.attributes['aria-selected'] === 'true');
  assert.equal(on.length, 1, 'no tab is marked current');
  assert.match(on[0].textContent, /Traders/, 'an address query landed on the assets tab');
  assert.ok(rows()[0].textContent.toLowerCase().includes(addr.slice(2, 6).toLowerCase()),
    'the first row is not the address that was typed');
});

test('a ticker goes the other way, and the tab follows the hits', async () => {
  await typeQuery('TSLA');
  const tabs = byClass(panel(), 'search-tab');
  const on = tabs.filter((/** @type {any} */ t) => t.attributes['aria-selected'] === 'true')[0];
  assert.match(on.textContent, /Assets/, 'a ticker query stayed on the traders tab');
  assert.ok(rows().length > 0, 'a ticker query rendered no rows');
  assert.match(rows()[0].textContent, /TSLA/);
});

test('the field asks for what this build can match', () => {
  /*
   * No token names and no trader names exist here. The asset endpoint carries symbol, kind,
   * price, volumes and counts; there is no name column in the store at all, and nothing
   * resolves an address to a handle. Asking for a name is asking for a miss.
   */
  const placeholder = input().attributes.placeholder ?? input().placeholder;
  assert.ok(!/names?/i.test(placeholder), `the field asks for names: ${placeholder}`);
  assert.match(placeholder, /ticker|symbol/i, 'the field does not say what it matches');
  const hint = byClass(panel(), 'search-empty-hint')[0];
  assert.ok(!/\bname\b/i.test(hint.textContent), `the empty state asks for a name: ${hint.textContent}`);
});

test('nothing matches, and it says so once', async () => {
  await typeQuery('zzzzzznotathing');
  assert.equal(rows().length, 0);
  const empty = byClass(panel(), 'search-empty')[0];
  assert.equal(empty.hidden, false, 'no empty state for a query with no hits');
  assert.match(empty.textContent, /zzzzzznotathing/, 'the empty state does not name the query');
  closeSearch();
});

test('the list is the whole answer, not the first thirty of it', async () => {
  /*
   * BOTH SIDES WERE SLICED TO 30 in lib/data.js, and the trader side only ever looked at the
   * ranked rows the page already had — the top 1,000 of the 25,357 addresses that closed a
   * round-trip, out of 113,315 the tape has a record for. /api/search had existed the whole
   * time, unused: a prefix lookup on the address table's primary key.
   *
   * So a one-character prefix has to come back with more than a page of addresses, and the
   * palette has to page through them rather than truncate. The count on the tab is the true
   * total; the DOM holds a window of it.
   */
  const { search } = await import('../web/lib/data.js');
  const res = await search('0x1');
  assert.ok(res.traders.length > 100,
    `a prefix search returned ${res.traders.length} addresses — it is reading the board, not the store`);

  await typeQuery('0x1');
  const tab = byClass(panel(), 'search-tab').find((/** @type {any} */ t) => /Traders/.test(t.textContent));
  const shown = Number(tab.textContent.replace(/\D+/g, ''));
  assert.equal(shown, res.traders.length, 'the tab count is the number rendered, not the number found');
  const first = rows().length;
  assert.ok(first > 0 && first < res.traders.length, 'the whole answer was built into the DOM at once');

  // Scrolling builds the next page — the list is windowed, not cut.
  const list = panel().descendants().find((/** @type {any} */ n) => String(n.className).includes('search-list'));
  list.scrollTop = 10_000;
  list.clientHeight = 400;
  list.scrollHeight = 500;
  list.listeners.filter((/** @type {any} */ l) => l.type === 'scroll').forEach((/** @type {any} */ l) => l.fn({}));
  assert.ok(rows().length > first, `the list did not grow past ${first} rows`);
});

test('an address the board never ranked is still findable', async () => {
  /*
   * Most of this chain never closed a round-trip, and the leaderboard is the top 1,000 of
   * those that did. A search that can only see the board answers "no matches" for the other
   * hundred thousand addresses, which is the opposite of what a search is for. The profile
   * those rows open says exactly what it knows about them.
   */
  const { sample: pick } = await import('./store.mjs');
  const quiet = pick({ where: 'round_trips = 0', limit: 1 })[0];
  const { search } = await import('../web/lib/data.js');
  const res = await search(quiet.address.slice(0, 8));
  assert.ok(res.traders.some((/** @type {any} */ t) => t.address === quiet.address),
    'an address with no round-trips is missing from its own prefix search');
});
