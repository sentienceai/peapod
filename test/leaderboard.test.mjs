/**
 * Renders the leaderboard against the shipped partitions and checks what it built.
 *
 * Two things here are not style and must not be lost to one: the coverage caveat sits
 * above every control so scope is read before the ranking, and every signed figure carries
 * its sign three ways — a direction glyph, an explicit sign character, and colour. Colour
 * plus a minus sign is two channels for most readers but not for someone colourblind
 * scanning a dense column, and a minus sign is a few pixels wide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { install } from './dom-stub.mjs';

const { get, clipboard } = await install(new URL('../web/index.html', import.meta.url));
await import('../web/index.js');

const index = JSON.parse(
  await readFile(new URL('../web/data/leaderboard/index.json', import.meta.url), 'utf8'),
);

test('the coverage caveat states scope before any ranking', () => {
  const text = get('caveat').textContent;
  const c = index.windows.at(-1).coverage;
  assert.match(text, /round-trips only/i);
  assert.match(text, /out of scope, not estimated/);

  // WHAT the window is, and over WHICH universe — not just a bare percentage.
  assert.ok(text.includes(c.window_label), 'caveat does not say which window');
  assert.ok(text.includes(c.universe), 'caveat does not say which pools');
  assert.match(text, /not included/, 'caveat does not say what is excluded');
  assert.match(text, /full 74-day tape/, 'caveat does not say this is not the whole tape');

  // The figures are the shipped ones, not prose that drifted from them.
  assert.ok(text.includes(`${c.qualifying_pct.toFixed(1)}%`),
    `caveat does not carry the real qualifying rate ${c.qualifying_pct.toFixed(1)}%`);
  assert.ok(text.includes(`${c.matched_flow_pct.toFixed(1)}%`),
    'caveat does not carry the real matched-flow share');
  assert.ok(text.includes(c.addresses_qualifying.toLocaleString('en-US')),
    'caveat does not carry the qualifying count');
});

test('the ranking says it is truncated rather than implying it is complete', () => {
  // The table shows a capped top-N. Presenting that as the full ranking would overstate
  // both an address's rank and the size of the field it beat.
  const text = get('caveat').textContent;
  const c = index.windows.at(-1).coverage;
  assert.ok(c.rows_shown < c.addresses_qualifying,
    'this assertion is moot if the cap ever exceeds the qualifying set');
  assert.ok(text.includes(`Showing the top ${c.rows_shown.toLocaleString('en-US')}`),
    'the caveat does not disclose the cap');
  const rows = get('rows').byTag('tr');
  assert.equal(rows.length, c.rows_shown - 3, 'table rows do not match the shipped count');
});

test('every signed figure carries a glyph AND a sign character AND colour', () => {
  const signed = [...get('podium').descendants(), ...get('rows').descendants()]
    .filter((n) => n.className === 'up' || n.className === 'down');
  assert.ok(signed.length > 10, `only ${signed.length} signed figures found`);
  for (const cell of signed) {
    const glyph = cell.byClass('mark');
    assert.equal(glyph.length, 1, `a signed figure has no direction glyph: ${cell.textContent}`);
    const isUp = cell.className === 'up';
    assert.equal(glyph[0].textContent, isUp ? '▲' : '▼');
    // The sign character survives if colour and glyph are both stripped.
    const rest = cell.textContent.replace(glyph[0].textContent, '');
    assert.match(rest, /^[+−]/, `no sign character on ${cell.textContent}`);
    assert.equal(rest.startsWith('−'), !isUp, `sign disagrees with class: ${rest}`);
  }
});

test('the podium is three cards and rank one carries the accent', () => {
  const cards = get('podium').byClass('pcard');
  assert.equal(cards.length, 3);
  assert.ok(cards[0].className.includes('pcard--first'), 'rank one is not marked');
  assert.equal(cards[1].className.includes('pcard--first'), false);
  for (const c of cards) {
    assert.equal(c.byClass('spark').length, 1, 'a podium card has no sparkline');
    assert.match(c.textContent, /Realized, round-trips only/);
  }
});

test('the table starts at rank four, as the podium holds one to three', () => {
  const rows = get('rows').byTag('tr');
  assert.ok(rows.length > 20, `only ${rows.length} table rows`);
  assert.equal(rows[0].byTag('td')[0].textContent, '4');
});

test('win rate is labelled as per round-trip, not per position', () => {
  const footnote = get('footnote').textContent;
  assert.match(footnote, /share of matched round-trips that closed at a profit/);
  assert.match(footnote, /not a share of closed positions/);
});

test('unavailable categories are disabled rather than shown empty', () => {
  const cats = get('categories').byTag('button');
  const pons = cats.find((b) => b.textContent === 'Pons');
  assert.ok(pons, 'Pons category missing');
  assert.equal(pons.disabled, true, 'Pons is selectable but has no data');
  const eth = get('quotes').byTag('button').find((b) => b.textContent === 'ETH');
  assert.ok(eth, 'ETH quote tab missing');
  assert.equal(eth.disabled, true, 'ETH quote is selectable but needs a price series');
});

test('no perps-state column survived into the table', () => {
  const head = get('head').textContent.toLowerCase();
  for (const banned of ['account value', 'equity', 'leverage', 'margin', 'liquidation',
    'direction', 'entry', 'mark', 'copy score', 'unrealized']) {
    assert.ok(!head.includes(banned), `table has a perps-state column: ${banned}`);
  }
});

test('rows and podium cards open the detail view', async () => {
  const rows = get('rows').byTag('tr');
  assert.ok(rows.every((r) => typeof r.onclick === 'function'), 'a row is not clickable');
  assert.ok(rows.every((r) => r.attributes['aria-label']?.startsWith('Open 0x')),
    'a row has no accessible label naming the address');
  assert.ok(rows.every((r) => typeof r.onkeydown === 'function'),
    'a row cannot be opened from the keyboard');
  const cards = get('podium').byClass('pcard');
  assert.ok(cards.every((c) => typeof c.onclick === 'function'), 'a podium card is not clickable');
});

test('the detail view renders without perps-state fields', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  const first = JSON.parse(
    await readFile(new URL('../web/data/leaderboard/rwa-usdg-all.json', import.meta.url), 'utf8'),
  ).rows[0];
  await openDetail(first.address);

  const rail = get('rail').textContent.toLowerCase();
  // Absent, not dashed: a dash in a financial field reads as a measured zero.
  for (const banned of ['account value', 'account equity', 'unrealized', 'leverage',
    'margin usage', 'liquidation', 'direction bias', 'copy score', 'sharpe']) {
    assert.ok(!rail.includes(banned), `the rail reintroduced a perps-state field: ${banned}`);
  }
  // A dash used as a VALUE is the tell. Prose may legitimately contain one, so check the
  // value cells rather than the whole rail.
  const placeholders = get('rail').byClass('rail-row')
    .map((row) => row.byTag('b')[0]?.textContent?.trim())
    .filter((v) => v === '—' || v === '-' || v === 'N/A' || v === '');
  assert.deepEqual(placeholders, [],
    'a rail row renders a placeholder where a value was cut; cut the row instead');

  // What the rail must carry instead.
  for (const required of ['realized', 'round-trips', 'win rate', 'matched volume',
    'total volume', 'matched share', 'median hold', 'longest win streak', 'style',
    'labels', 'out of scope']) {
    assert.ok(rail.includes(required), `the rail is missing ${required}`);
  }
});

test('every label ships its criteria beside it', () => {
  const items = get('rail').byClass('label-item');
  assert.ok(items.length >= 4, `only ${items.length} labels`);
  for (const item of items) {
    const small = item.byTag('small');
    assert.equal(small.length, 1, 'a label has no criteria');
    assert.ok(small[0].textContent.length > 25, `criteria too thin: ${small[0].textContent}`);
    assert.ok(['true', 'false'].includes(item.dataset.earned));
  }
  assert.ok(!get('rail').textContent.toLowerCase().includes('smart money'),
    'a smart-money label appeared');
});

test('the win/loss strip is one square per round-trip and reads without colour', () => {
  const strip = get('metrics').byClass('streak')[0];
  assert.ok(strip, 'no win/loss strip');
  const squares = strip.byTag('i');
  assert.ok(squares.length > 0);
  // Losses are hollow, wins filled — the distinction survives colour being stripped.
  assert.ok(squares.some((s) => s.className === 'loss') || squares.every((s) => s.className === ''),
    'losses are not distinguishable from wins by shape');
  assert.match(get('metrics').textContent, /filled is a win/);
});

test('the metric grid has four cards and none needs the transfer index', () => {
  const cards = get('metrics').byClass('metric');
  assert.equal(cards.length, 4, 'the grid lost or gained a card');
  const text = get('metrics').textContent.toLowerCase();
  assert.match(text, /performance/);
  assert.match(text, /matched flow/);
  assert.match(text, /out of scope/);
  assert.match(text, /holding/);
});

test('the out-of-scope note states the amount and refuses to estimate it', () => {
  const note = get('rail').byClass('scope-note')[0].textContent;
  assert.match(note, /with no matching on-chain buy/);
  assert.match(note, /no cost basis is guessed/);
});


test('a detail file exists for every qualifying address, not just the ranked ones', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../web/data/address/', import.meta.url);
  const shards = await readdir(root);
  let files = 0;
  for (const shard of shards) files += (await readdir(new URL(`${shard}/`, root))).length;
  const c = index.windows.at(-1).coverage;
  assert.ok(files >= c.addresses_qualifying,
    `${files} detail files for ${c.addresses_qualifying} qualifying addresses — search `
    + 'would 404 for anyone outside the shipped set');
  // And for the addresses that traded without qualifying, too.
  assert.ok(files >= c.addresses_seen * 0.99,
    `${files} files for ${c.addresses_seen} addresses that traded`);
});

test('addresses are sharded so no directory holds the whole set', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../web/data/address/', import.meta.url);
  const shards = await readdir(root);
  assert.ok(shards.length > 200, `only ${shards.length} shards`);
  assert.ok(shards.every((s) => /^[0-9a-f]{2}$/.test(s)), 'a shard is not a 2-hex prefix');
});

test('an address that traded without a round-trip gets an explanation, not an error', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = new URL('../web/data/address/', import.meta.url);
  const shards = await readdir(root);
  /** @type {any} */
  let sample = null;
  outer: for (const shard of shards.slice(0, 12)) {
    for (const name of await readdir(new URL(`${shard}/`, root))) {
      const d = JSON.parse(await readFile(new URL(`${shard}/${name}`, root), 'utf8'));
      if (d.status === 'no_round_trips' && d.summary.total_volume > 0) { sample = d; break outer; }
    }
  }
  assert.ok(sample, 'no non-qualifying address found to check');
  assert.ok(sample.explain, 'a non-qualifying address has no explanation');
  assert.match(sample.explain.headline, /No completed round-trips/);
  assert.match(sample.explain.not_estimated, /No cost basis is guessed/);

  const { openDetail } = await import('../web/lib/detail.js');
  await openDetail(sample.address);
  const note = get('subtable').textContent;
  assert.match(note, /No completed round-trips/);
  assert.ok(!/no results/i.test(note), 'the empty-search wording leaked into a real address');
  // It says what the address DID do rather than only what it lacks.
  const rail = get('rail').textContent;
  assert.match(rail, /Position changes/);
  assert.match(rail, /Sold with no on-chain buy/);
  // And shows no realized figure rather than a zero.
  assert.match(rail, /No realized PnL/);
  assert.ok(!/\+\$0\.00/.test(rail), 'a zero was rendered where there is no figure');
});

test('an address absent from the tape is told so, and told what that means', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  await openDetail('0x' + 'ab'.repeat(20));
  const note = get('subtable').textContent;
  assert.match(note, /No activity in this window/);
  assert.match(note, /not that it has never traded/);
});

test('the tab bar carries only tabs we can fill', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  const top = JSON.parse(
    await readFile(new URL('../web/data/leaderboard/rwa-usdg-all.json', import.meta.url), 'utf8'),
  ).rows[0];
  await openDetail(top.address);

  const labels = get('subtabs').byTag('button').map((b) => b.textContent);
  assert.deepEqual(labels, ['Round-trips', 'Trades', 'Tokens', 'Performance']);
  // Positions, Balances and Transfers need the transfer index. They are not stubbed and
  // not greyed out — a disabled tab still advertises a feature that does not exist.
  for (const absent of ['Positions', 'Balances', 'Transfers', 'Orders', 'Fills', 'TWAP']) {
    assert.ok(!labels.includes(absent), `${absent} appeared without the transfer index`);
  }
});

test('each tab renders rows from the shipped data', async () => {
  const buttons = get('subtabs').byTag('button');
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].onclick?.(/** @type {any} */ ({}));
    const text = get('subtable').textContent;
    assert.ok(text.length > 40, `tab ${i} rendered nothing`);
    assert.ok(!/undefined|NaN|\[object/.test(text), `tab ${i} leaked a broken value: ${text.slice(0, 80)}`);
  }
});

test('the performance tab aggregates every round-trip, not the capped list', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../web/data/address/', import.meta.url);
  /** @type {any} */
  let heavy = null;
  outer: for (const shard of (await readdir(root)).slice(0, 40)) {
    for (const name of await readdir(new URL(`${shard}/`, root))) {
      const d = JSON.parse(await readFile(new URL(`${shard}/${name}`, root), 'utf8'));
      if (d.status === 'qualified' && d.summary.round_trips > 250) { heavy = d; break outer; }
    }
  }
  assert.ok(heavy, 'no address with more round-trips than the shipped cap');
  assert.ok(heavy.round_trips.length <= 200, 'the round-trip list is not capped');
  const dailyTrips = heavy.daily.reduce((/** @type {number} */ a, /** @type {any} */ r) => a + r.round_trips, 0);
  assert.equal(dailyTrips, heavy.summary.round_trips,
    'daily totals were computed from the truncated list rather than every round-trip');
});

test('the chart splits fill and stroke at zero rather than colouring by final value', async () => {
  const { areaChart } = await import('../web/lib/chart.js');
  // A series that dips negative and recovers: both colours must appear.
  const { svg } = areaChart([[0, -5], [1, -8], [2, 3], [3, 9]], { width: 100, height: 50 });
  const all = /** @type {any} */ (svg).descendants();
  const fills = all.map((/** @type {any} */ n) => n.attributes.fill).filter(Boolean);
  const strokes = all.map((/** @type {any} */ n) => n.attributes.stroke).filter(Boolean);
  assert.ok(fills.includes('var(--up-fill)'), 'no positive fill');
  assert.ok(fills.includes('var(--down-fill)'), 'no negative fill');
  assert.ok(strokes.includes('var(--up)'), 'no positive stroke');
  assert.ok(strokes.includes('var(--down)'), 'no negative stroke');
  // Each is clipped to its own half-plane.
  const clipped = all.filter((/** @type {any} */ n) => n.attributes['clip-path']);
  assert.equal(clipped.length, 4, 'fill and stroke are not both split at zero');
  assert.equal(all.filter((/** @type {any} */ n) => n.tag === 'clipPath').length, 2);
});

test('two charts on one page do not share clip ids', async () => {
  const { areaChart } = await import('../web/lib/chart.js');
  const a = areaChart([[0, -1], [1, 1]], {});
  const b = areaChart([[0, -1], [1, 1]], {});
  const idOf = (/** @type {any} */ c) => c.svg.descendants()
    .filter((/** @type {any} */ n) => n.tag === 'clipPath')[0].attributes.id;
  assert.notEqual(idOf(a), idOf(b), 'clip ids collide, so one chart would clip the other');
});

test('tokens render a logo where we have one and initials where we do not', async () => {
  const { setTokenLogos, tokenCell } = await import('../web/lib/token.js');
  setTokenLogos({ SPY: '0x1111111111111111111111111111111111111111.png' });

  const known = /** @type {any} */ (tokenCell('SPY'));
  const img = known.descendants().find((/** @type {any} */ n) => n.tag === 'img');
  assert.ok(img, 'a token with a mapped logo rendered no image');
  assert.equal(img.attributes.src, '/token-logos/0x1111111111111111111111111111111111111111.png');
  assert.equal(img.attributes.alt, '', 'the ticker is already text; the logo is decorative');
  assert.ok(known.descendants().some((/** @type {any} */ n) => n.className === 'token-tile'
    && n.textContent === 'SP'), 'no initials tile underneath the image');
  assert.ok(known.textContent.includes('SPY'), 'the ticker itself is not readable');

  const unknown = /** @type {any} */ (tokenCell('ZZZZ'));
  assert.equal(unknown.descendants().filter((/** @type {any} */ n) => n.tag === 'img').length, 0);
  assert.ok(unknown.descendants().some((/** @type {any} */ n) => n.textContent === 'ZZ'));
});

test('a logo filename that is not one of ours never reaches a URL', async () => {
  const { setTokenLogos, tokenCell } = await import('../web/lib/token.js');
  for (const bad of ['../../etc/passwd', 'x.png', '0xabc.png', 'sPy.PNG',
    '0x1111111111111111111111111111111111111111.svg',
    '0x1111111111111111111111111111111111111111.png?x=1']) {
    setTokenLogos({ SPY: bad });
    assert.equal(/** @type {any} */ (tokenCell('SPY')).descendants()
      .filter((/** @type {any} */ n) => n.tag === 'img').length, 0,
    `a rejected filename reached the DOM: ${bad}`);
  }
});

test('a broken image falls back to the tile without being bound to individually', async () => {
  const { setTokenLogos, tokenCell } = await import('../web/lib/token.js');
  setTokenLogos({ SPY: '0x1111111111111111111111111111111111111111.png' });

  // Attached after load, the way the modal attaches its rows: the delegated listener has
  // to catch this without anyone having bound to this particular image.
  const cell = /** @type {any} */ (tokenCell('SPY'));
  get('subtable').append(cell);

  const img = cell.descendants().find((/** @type {any} */ n) => n.tag === 'img');
  assert.equal(img.listeners.length, 0, 'the image carries its own error handler');

  img.dispatchEvent({ type: 'error' });

  assert.equal(cell.descendants().filter((/** @type {any} */ n) => n.tag === 'img').length, 0,
    'the failed image is still in the DOM, so it renders as a broken-image glyph');
  const tile = cell.descendants().find((/** @type {any} */ n) => n.className === 'token-tile');
  assert.ok(tile && tile.textContent === 'SP', 'no initials left once the image failed');
  assert.ok(cell.textContent.includes('SPY'), 'the ticker went with the image');
  cell.remove();
});

test('token logos reach the leaderboard column and every tab that names a token', async () => {
  const logos = JSON.parse(
    await readFile(new URL('../web/data/tokens.json', import.meta.url), 'utf8'),
  );
  const { setTokenLogos } = await import('../web/lib/token.js');
  setTokenLogos(logos);
  // Earlier tests leave their own map behind, and the rows were built at boot. Force a
  // re-render so this asserts what the page builds, not what it built before.
  get('head').byTag('button')[0].onclick?.(/** @type {any} */ ({}));

  const chipImgs = get('rows').descendants()
    .filter((/** @type {any} */ n) => n.tag === 'img' && n.attributes['data-token-logo'] !== undefined);
  assert.ok(chipImgs.length > 0, 'the Tokens column renders no logos');
  assert.ok(chipImgs.every((/** @type {any} */ n) => /^\/token-logos\/0x[0-9a-f]{40}\.(png|jpg|jpeg|webp)$/
    .test(n.attributes.src)), 'a logo src is not a token-logos path');

  const { openDetail } = await import('../web/lib/detail.js');
  const top = JSON.parse(
    await readFile(new URL('../web/data/leaderboard/rwa-usdg-all.json', import.meta.url), 'utf8'),
  ).rows[0];
  await openDetail(top.address);
  const buttons = get('subtabs').byTag('button');
  const labels = buttons.map((/** @type {any} */ b) => b.textContent);
  for (const label of ['Round-trips', 'Trades', 'Tokens']) {
    buttons[labels.indexOf(label)].onclick?.(/** @type {any} */ ({}));
    const rendered = get('subtable').descendants();
    assert.ok(rendered.some((/** @type {any} */ n) => n.className === 'token-tile'),
      `${label} names tokens without the icon treatment`);
    assert.ok(rendered.some((/** @type {any} */ n) => n.tag === 'img'
      && n.attributes['data-token-logo'] !== undefined), `${label} renders no logos at all`);
  }
});

test('every ticker the shipped data actually uses resolves to a logo file', async () => {
  // Coverage is 35 of the top 50 by volume across the whole registry, but the page only
  // ever names the tokens that were traded. If one of those is missing a file the tile is
  // correct behaviour, not a bug — this pins the number so a drop is visible.
  const { readdir } = await import('node:fs/promises');
  const logos = JSON.parse(
    await readFile(new URL('../web/data/tokens.json', import.meta.url), 'utf8'),
  );
  const root = new URL('../web/data/address/', import.meta.url);
  const used = new Set();
  for (const shard of (await readdir(root)).slice(0, 12)) {
    for (const name of (await readdir(new URL(`${shard}/`, root))).slice(0, 40)) {
      const d = JSON.parse(await readFile(new URL(`${shard}/${name}`, root), 'utf8'));
      for (const t of d.tokens ?? []) used.add(t.token);
      for (const t of d.round_trips ?? []) used.add(t.token);
      for (const t of d.trades ?? []) used.add(t.token);
    }
  }
  assert.ok(used.size > 20, 'the sample found too few tickers to say anything');
  const missing = [...used].filter((t) => !logos[t]);
  assert.deepEqual(missing, [], `tickers in use with no logo: ${missing.join(', ')}`);
});

/**
 * A click as the row beneath it would see one: cancellable, and it records interference.
 * @returns {[any, {stopped: boolean, prevented: boolean}]}
 */
function clickEvent() {
  const seen = { stopped: false, prevented: false };
  return [{
    key: 'Enter',
    stopPropagation() { seen.stopped = true; },
    preventDefault() { seen.prevented = true; },
  }, seen];
}

/** @param {any} root */
const copiesIn = (root) => root.descendants()
  .filter((/** @type {any} */ n) => n.tag === 'button'
    && String(n.className).split(' ').includes('copy'));

test('every address on the leaderboard can be taken, at full length', () => {
  const rows = get('rows').byTag('tr');
  assert.ok(rows.length > 0);
  for (const tr of rows) {
    const buttons = copiesIn(tr);
    assert.equal(buttons.length, 1, 'a row has no copy button, or more than one');
    const label = buttons[0].attributes['aria-label'];
    // The visible text is shortened. What gets copied must not be.
    assert.match(label, /^Copy address 0x[0-9a-f]{40}$/,
      `copy button does not name a full address: ${label}`);
    assert.ok(!label.includes('…'), 'the copy button offers the shortened address');
  }
  // Exactly the cards: 'pcard-top' and 'pcard-addr' start with the same letters.
  for (const card of get('podium').descendants()
    .filter((/** @type {any} */ n) => String(n.className).split(' ').includes('pcard'))) {
    assert.equal(copiesIn(card).length, 1, 'a podium card has no copy button');
  }
});

test('copying puts the whole address on the clipboard and says it did', async () => {
  clipboard.mode = 'ok';
  clipboard.writes.length = 0;
  const row = get('rows').byTag('tr')[0];
  const button = copiesIn(row)[0];
  const full = button.attributes['aria-label'].replace('Copy address ', '');

  const [e, seen] = clickEvent();
  await button.onclick?.(e);

  assert.deepEqual(clipboard.writes, [full]);
  assert.ok(button.textContent.includes('Copied'), 'no confirmation after a copy');
  assert.equal(button.className, 'copy is-ok');
  // Announced, not only drawn: a tick that is just a colour is not a confirmation.
  const live = button.descendants().find((/** @type {any} */ n) => n.className === 'copy-live');
  assert.equal(live.attributes.role, 'status');
  assert.ok(seen.stopped, 'the click reached the row, which would also open the modal');
});

test('a refused clipboard says so rather than pretending it worked', async () => {
  clipboard.mode = 'reject';
  clipboard.writes.length = 0;
  const button = copiesIn(get('rows').byTag('tr')[1])[0];

  const [e] = clickEvent();
  await button.onclick?.(e);

  assert.deepEqual(clipboard.writes, [], 'a rejected write still recorded something');
  assert.ok(button.textContent.includes('Copy failed'),
    'a refused copy left the person believing they have the address');
  assert.equal(button.className, 'copy is-fail');
  clipboard.mode = 'ok';
});

test('an absent clipboard is a failure state, not a crash', async () => {
  clipboard.mode = 'absent';
  const button = copiesIn(get('rows').byTag('tr')[2])[0];
  const [e] = clickEvent();
  await button.onclick?.(e);
  assert.ok(button.textContent.includes('Copy failed'),
    'no clipboard API on an insecure origin, and the button claimed success');
  clipboard.mode = 'ok';
});

test('the confirmation is brief, and Enter on it does not open the modal', async () => {
  clipboard.mode = 'ok';
  const button = copiesIn(get('rows').byTag('tr')[3])[0];
  const [e] = clickEvent();
  await button.onclick?.(e);
  assert.equal(button.className, 'copy is-ok');

  await new Promise((r) => { setTimeout(r, 1400); });
  assert.equal(button.className, 'copy', 'the confirmation never reverted');
  assert.ok(!button.textContent.includes('Copied'));

  const [k, keySeen] = clickEvent();
  button.onkeydown?.(k);
  assert.ok(keySeen.stopped, 'Enter on copy also reaches the row and opens the modal');
});

test('the detail rail carries the copy glyph next to the address', async () => {
  const { openDetail } = await import('../web/lib/detail.js');
  const top = JSON.parse(
    await readFile(new URL('../web/data/leaderboard/rwa-usdg-all.json', import.meta.url), 'utf8'),
  ).rows[0];
  await openDetail(top.address);

  const buttons = copiesIn(get('rail'));
  assert.equal(buttons.length, 1, 'the rail has no copy button, or more than one');
  assert.equal(buttons[0].attributes['aria-label'], `Copy address ${top.address}`);
  // The rail also prints the address in full, so a refused clipboard still leaves
  // something selectable rather than only a shortened form.
  assert.ok(get('rail').textContent.includes(top.address));

  clipboard.writes.length = 0;
  const [e] = clickEvent();
  await buttons[0].onclick?.(e);
  assert.deepEqual(clipboard.writes, [top.address]);
});
