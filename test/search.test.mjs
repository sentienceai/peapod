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
