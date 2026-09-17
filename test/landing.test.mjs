/**
 * The landing page, which is the one page that sells rather than reports.
 *
 * It is drawn from the design frames and speaks in their voice: copy trading, the strategy
 * builder and the phone app are presented as the product, not caveated out of existence. Two
 * things have to stay true underneath that voice, and both are here:
 *
 *   1. EVERY FIGURE IS THE SAME FIGURE THE APP SHOWS. The hero strip and the "built for
 *      signal" strip count addresses; so does the leaderboard's caveat. They must be the same
 *      count, from the same payload — two true numbers from different scopes, sitting in a
 *      strip next to each other, read as one page disagreeing with itself. (test/site's own
 *      landing rule covers the other half: no figure that nothing measured.)
 *   2. WHAT IS NOT LIVE SAYS SO WHERE IT IS SOLD. "Coming soon" is a promise, not a
 *      disclaimer, and it belongs beside the thing being promised — not in a footnote at the
 *      bottom of the page and not nowhere at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { byClass, openPage } from './page.mjs';

const { get } = await openPage('index', 'landing');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

/** The board payload the leaderboard itself renders, to check the page against. */
async function boardPayload() {
  const { Api, route } = await import('../web-api.mjs');
  const { fileURLToPath } = await import('node:url');
  const { gunzipSync } = await import('node:zlib');
  const api = new Api(process.env.PEAPOD_DB || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));
  try {
    const out = /** @type {any} */ (route(api, new URL('http://x/api/leaderboard/all/7d')));
    if (out.status !== 200) return null;
    return JSON.parse(out.gzip ? gunzipSync(Buffer.from(out.body)).toString('utf8') : String(out.body));
  } finally {
    api.close();
  }
}

test('the page\'s counts are the leaderboard\'s own, not a second set', async () => {
  const payload = await boardPayload();
  const c = payload?.coverage;
  assert.ok(c, 'the build publishes no coverage block to check against');
  const cells = byClass(get('signal-stats'), 'lp-strip-cell').map((/** @type {any} */ n) => n.textContent);
  const hero = byClass(get('hero-stats'), 'lp-hstat').map((/** @type {any} */ n) => n.textContent);
  assert.ok(cells.length === 4 && hero.length === 4, 'the strips did not render');

  const seen = Number(c.addresses_seen).toLocaleString('en-US');
  const qualifying = Number(c.addresses_qualifying).toLocaleString('en-US');
  assert.ok(cells.some((/** @type {string} */ t) => t.includes(seen)),
    `"addresses seen" is not the board's ${seen}: ${cells.join(' | ')}`);
  assert.ok(cells.some((/** @type {string} */ t) => t.includes(qualifying)),
    `"closed a round-trip" is not the board's ${qualifying}: ${cells.join(' | ')}`);
  assert.ok(hero.some((/** @type {string} */ t) => t.includes(qualifying)),
    `"wallets qualifying" is not the board's ${qualifying}: ${hero.join(' | ')}`);
  // The window is named on the volume cell, because a count of addresses over seven days and
  // the same count over one day are different numbers with the same label.
  assert.ok(hero.some((/** @type {string} */ t) => t.includes(String(payload.window).toUpperCase())),
    'nothing in the hero strip says which window these figures cover');
});

test('the podium is the board\'s top three, in its order', async () => {
  const payload = await boardPayload();
  const cards = byClass(get('hero-podium'), 'lp-podium-card');
  assert.equal(cards.length, 3);
  for (const [i, card] of cards.entries()) {
    const addr = payload.rows[i].address;
    const shown = byClass(card, 'lp-podium-name')[0].textContent;
    // Shortened for the card: the head and tail have to be this row's and nobody else's.
    assert.ok(addr.startsWith(shown.slice(0, 6)) && addr.endsWith(shown.slice(-4)),
      `podium ${i + 1} shows ${shown}, the board ranks ${addr}`);
  }
});

test('what is not live says so beside what is being sold', () => {
  /*
   * The frames sell three things this build does not do: copying, the strategy builder and
   * the phone app. Each may be sold in the present tense of a product being built — what it
   * may not do is read as shipped. The marker lives in the section itself, which is where a
   * reader who scrolls to one section and no further will see it.
   */
  const text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const [id, what] of [['product', 'copy trading'], ['build', 'the strategy builder'],
    ['mobile', 'the phone app']]) {
    const start = text.indexOf(`id="${id}"`);
    assert.ok(start > 0, `the ${id} section is gone`);
    const section = text.slice(start, text.indexOf('<section', start + 1));
    assert.match(section, /COMING SOON|not live yet|is not built|being built/i,
      `${what} is sold in the ${id} section with nothing saying it is not live yet`);
  }
  // And the one button that would collect an address for it stays inert while there is
  // nothing to sign up to.
  const cta = /<button[^>]*lp-btn[^>]*>[^<]*early access[^<]*<\/button>/i.exec(text);
  assert.ok(cta, 'the early-access button is gone');
  assert.match(cta[0], /\bdisabled\b/, 'the early-access button takes a click and does nothing');
});
