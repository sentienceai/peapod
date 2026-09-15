/**
 * The trader detail modal.
 *
 * Follows the reference's two-column shape: a summary rail on the left, performance on the
 * right with a metric grid, a cumulative chart, and a tabbed table beneath.
 *
 * WHAT IS ABSENT, AND WHY IT IS ABSENT RATHER THAN EMPTY. Their rail opens with account
 * value, account equity split across perps/spot/staked, unrealized PnL, leverage and margin
 * usage. None of those exist for an address on a spot AMM without a balance engine over the
 * transfer index. A dash in a financial field reads as a measured zero, so those rows are
 * not rendered at all. Their 2x2 metric grid loses three of four cards for the same reason;
 * the grid is refilled with quantities the swap record actually supports.
 */

import { areaChart } from './chart.js';

const NS_TEXT = (/** @type {string} */ t) => document.createTextNode(t);
/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {string} [cls] @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** @param {number} n */
const money = (n) => `$${Math.abs(n) < 10000 ? usd2.format(n) : usd0.format(Math.round(n))}`;
/** @param {number} n */
function signed(n, cls = '') {
  const s = node('span', `${n >= 0 ? 'up' : 'down'} ${cls}`.trim());
  s.append(node('span', 'mark', n >= 0 ? '▲' : '▼'));
  s.append(NS_TEXT(`${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`));
  return s;
}
/**
 * A hold time. Zero is a real measurement here — a round-trip closed in the same block
 * held for zero seconds — so it renders as 0s. A dash would claim the value is unknown.
 * @param {number} s
 */
function duration(s) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
/** @param {number} ts */
const when = (ts) => new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ');
/** @param {string} a */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const RANGES = [['24H', 86400], ['7D', 604800], ['30D', 2592000], ['All', Infinity]];
/** @typedef {any} Detail */
let range = Infinity;

/** @param {string} title @param {{key: string, value: Node|string}[]} rows */
function railBlock(title, rows) {
  const b = node('div', 'rail-block');
  b.append(node('h4', undefined, title));
  for (const r of rows) {
    const line = node('div', 'rail-row');
    line.append(node('span', undefined, r.key));
    const v = node('b');
    if (typeof r.value === 'string') v.textContent = r.value;
    else v.append(r.value);
    line.append(v);
    b.append(line);
  }
  return b;
}

/** @param {Detail} d */
function renderRail(d) {
  const s = d.summary;
  const rail = el('rail');
  rail.replaceChildren();

  const id = node('div', 'rail-id');
  const av = node('span', 'avatar', '◇');
  const names = node('div');
  names.append(node('b', undefined, shortAddr(d.address)));
  names.append(node('small', undefined, d.address));
  id.append(av, names);
  rail.append(id);

  const fig = node('div', 'rail-figure');
  const strong = node('strong');
  strong.append(signed(s.realized));
  fig.append(strong, node('span', undefined, 'Realized · round-trips only'));
  rail.append(fig);

  rail.append(railBlock('Activity', [
    { key: 'Round-trips', value: String(s.round_trips) },
    { key: 'Win rate', value: `${s.win_rate.toFixed(1)}%` },
    { key: 'Matched volume', value: money(s.matched_volume) },
    { key: 'Total volume', value: money(s.total_volume) },
    { key: 'Matched share', value: `${s.matched_share_pct.toFixed(1)}%` },
    { key: 'Position changes', value: String(s.position_changes) },
    { key: 'Tokens traded', value: String(s.tokens_traded) },
  ]));

  rail.append(railBlock('Timing', [
    { key: 'Median hold', value: duration(s.median_hold_s) },
    { key: 'Average hold', value: duration(s.avg_hold_s) },
    { key: 'Longest win streak', value: String(s.longest_win_streak) },
    { key: 'Style', value: s.style },
  ]));

  const labels = node('div', 'rail-block');
  labels.append(node('h4', undefined, 'Labels'));
  for (const l of d.labels) {
    const item = node('div', 'label-item');
    item.dataset.earned = String(l.earned);
    item.append(node('b', undefined, l.label));
    item.append(node('small', undefined, l.criteria));
    labels.append(item);
  }
  rail.append(labels);

  const scope = node('div', 'rail-block');
  scope.append(node('h4', undefined, 'Out of scope'));
  const note = node('p', 'scope-note');
  note.append(NS_TEXT('This address sold '));
  note.append(node('b', undefined, money(s.out_of_scope_volume)));
  note.append(NS_TEXT(` (${s.out_of_scope_pct.toFixed(1)}% of its volume) with no matching `
    + 'on-chain buy. Those units are not counted here, and no cost basis is guessed for them.'));
  scope.append(note);
  rail.append(scope);
}

/** @param {Detail} d */
function renderMetrics(d) {
  const s = d.summary;
  const grid = el('metrics');
  grid.replaceChildren();

  const perf = node('div', 'metric');
  perf.append(node('h5', undefined, 'Performance'));
  const big = node('div', 'big');
  big.append(signed(s.realized));
  perf.append(big);
  const strip = node('div', 'streak');
  for (const w of d.sequence) strip.append(node('i', w ? '' : 'loss'));
  perf.append(strip);
  perf.append(node('div', 'foot',
    `${s.win_rate.toFixed(1)}% win rate · ${s.round_trips} round-trips · filled is a win`));
  grid.append(perf);

  const flow = node('div', 'metric');
  flow.append(node('h5', undefined, 'Matched flow'));
  flow.append(node('div', 'big', `${s.matched_share_pct.toFixed(1)}%`));
  const bar = node('div', 'bar');
  const fill = node('i');
  fill.style.width = `${Math.min(s.matched_share_pct, 100)}%`;
  bar.append(fill);
  flow.append(bar);
  flow.append(node('div', 'foot',
    `${money(s.matched_volume)} of ${money(s.total_volume)} round-tripped`));
  grid.append(flow);

  const scope = node('div', 'metric');
  scope.append(node('h5', undefined, 'Out of scope'));
  scope.append(node('div', 'big', `${s.out_of_scope_pct.toFixed(1)}%`));
  const bar2 = node('div', 'bar');
  const fill2 = node('i', 'warn');
  fill2.style.width = `${Math.min(s.out_of_scope_pct, 100)}%`;
  bar2.append(fill2);
  scope.append(bar2);
  scope.append(node('div', 'foot', 'Sold with no on-chain buy. Not counted, not estimated.'));
  grid.append(scope);

  const timing = node('div', 'metric');
  timing.append(node('h5', undefined, 'Holding'));
  timing.append(node('div', 'big', duration(s.median_hold_s)));
  timing.append(node('div', 'foot',
    `median · ${duration(s.avg_hold_s)} average · style from median hold only`));
  grid.append(timing);
}

/** @param {Detail} d */
function renderChart(d) {
  const stage = el('chart-stage');
  const tip = el('tip');
  [...stage.children].filter((c) => c !== tip).forEach((c) => c.remove());

  const cutoff = range === Infinity ? -Infinity : d.window.to_ts - range;
  const series = d.series.filter((/** @type {number[]} */ p) => p[0] >= cutoff);
  const total = series.length ? series[series.length - 1][1] : 0;
  const head = el('chart-total');
  head.replaceChildren();
  head.append(signed(total));

  const { svg, at, clear } = areaChart(series, { width: 900, height: 220 });
  stage.prepend(svg);
  if (!at) return;
  svg.addEventListener('mousemove', (e) => {
    const r = stage.getBoundingClientRect();
    const hit = at((e.clientX - r.left) / r.width);
    if (!hit) return;
    tip.hidden = false;
    tip.style.left = `${hit.x * 100}%`;
    tip.style.top = '12px';
    tip.replaceChildren();
    const b = node('b');
    b.append(signed(hit.point[1]));
    tip.append(b, node('span', undefined, when(hit.point[0])));
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; clear?.(); });
}

const TABS = [
  ['Round-trips', (/** @type {Detail} */ d) => ({
    cols: ['Token', 'Qty', 'Bought', 'Sold', 'Held', 'Closed', 'Realized'],
    rows: d.round_trips.map((/** @type {any} */ t) => [t.token, t.qty.toFixed(4), money(t.buy),
      money(t.sell), duration(t.held), when(t.closed), signed(t.realized)]),
    empty: 'No completed round-trips.',
  })],
  ['Trades', (/** @type {Detail} */ d) => ({
    cols: ['Time', 'Token', 'Side', 'Qty', 'Price', 'Value'],
    rows: (d.trades ?? []).map((/** @type {any} */ t) => {
      const side = node('span', t.side === 'buy' ? 'up' : 'down');
      side.append(node('span', 'mark', t.side === 'buy' ? '▲' : '▼'));
      side.append(NS_TEXT(t.side === 'buy' ? 'Buy' : 'Sell'));
      return [when(t.ts), t.token, side, t.qty.toFixed(4), money(t.price), money(t.value)];
    }),
    empty: 'No position changes in this window.',
    note: 'Most recent 100. Each row is one transaction netted across its legs, not one swap.',
  })],
  ['Tokens', (/** @type {Detail} */ d) => ({
    cols: ['Token', 'Round-trips', 'Win rate', 'Matched vol', 'Realized'],
    rows: d.tokens.map((/** @type {any} */ t) => [t.token, String(t.round_trips),
      `${t.win_rate.toFixed(0)}%`, money(t.matched), signed(t.realized)]),
    empty: 'No token has a completed round-trip.',
  })],
  ['Performance', (/** @type {Detail} */ d) => ({
    cols: ['Day', 'Round-trips', 'Win rate', 'Realized'],
    rows: (d.daily ?? []).map((/** @type {any} */ r) => [r.day, String(r.round_trips),
      `${r.win_rate.toFixed(0)}%`, signed(r.realized)]),
    empty: 'No day has a completed round-trip.',
    note: 'Realized PnL by UTC day, aggregated over every round-trip — not only the '
      + 'hundred listed under Round-trips.',
  })],
];
let tab = 0;

/** @param {Detail} d */
function renderTable(d) {
  const bar = el('subtabs');
  bar.replaceChildren();
  TABS.forEach(([label], /** @type {number} */ i) => {
    const b = node('button', undefined, /** @type {string} */ (label));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === tab));
    b.onclick = () => { tab = i; renderTable(d); };
    bar.append(b);
  });
  const { cols, rows, empty, note } = /** @type {any} */ (TABS[tab][1])(d);
  if (!rows.length) {
    const box = node('div', 'state-note');
    box.append(node('p', undefined, empty));
    el('subtable').replaceChildren(box);
    return;
  }
  const table = node('table', 'mini');
  const thead = node('thead');
  const hr = node('tr');
  for (const c of cols) {
    const th = node('th', undefined, c);
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = node('tbody');
  for (const r of rows) {
    const tr = node('tr');
    for (const cell of /** @type {any[]} */ (r)) {
      const td = node('td');
      if (typeof cell === 'string') td.textContent = cell;
      else td.append(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const wrap = node('div');
  wrap.append(table);
  if (note) wrap.append(node('p', 'table-note', note));
  el('subtable').replaceChildren(wrap);
}

/** @param {Detail} d */
function renderRanges(d) {
  const bar = el('chart-range');
  bar.replaceChildren();
  for (const [label, secs] of RANGES) {
    const b = node('button', undefined, /** @type {string} */ (label));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(secs === range));
    b.onclick = () => { range = /** @type {number} */ (secs); renderRanges(d); renderChart(d); };
    bar.append(b);
  }
}

/**
 * Three outcomes, and only one of them is "not found".
 *
 *   qualified        the full detail view
 *   no_round_trips   the address is on the tape but never completed a round-trip. It gets
 *                    an explanation of what it did do, because "no results" would be both
 *                    unhelpful and untrue — 39,000 addresses are in this state and it is
 *                    the normal way to hold a tokenized equity.
 *   absent           genuinely not in this window
 *
 * @param {string} address
 */
export async function openDetail(address) {
  const shard = address.slice(2, 4);
  const res = await fetch(`/data/address/${shard}/${address}.json`);
  if (!res.ok) {
    renderAbsent(address);
    el('modal').hidden = false;
    return;
  }
  const d = await res.json();
  if (d.status === 'no_round_trips') {
    renderNoRoundTrips(d);
    el('modal').hidden = false;
    return;
  }
  range = Infinity;
  tab = 0;
  el('modal-addr').textContent = shortAddr(address);
  renderRail(d);
  renderMetrics(d);
  renderRanges(d);
  renderChart(d);
  renderTable(d);
  el('modal').hidden = false;
}

/** @param {string} address */
function renderAbsent(address) {
  el('modal-addr').textContent = shortAddr(address);
  el('rail').replaceChildren();
  el('metrics').replaceChildren();
  el('chart-range').replaceChildren();
  el('chart-total').replaceChildren();
  el('subtabs').replaceChildren();
  const stage = el('chart-stage');
  [...stage.children].filter((c) => c.id !== 'tip').forEach((c) => c.remove());

  const box = node('div', 'state-note');
  box.append(node('h3', undefined, 'No activity in this window.'));
  box.append(node('p', undefined,
    `${address} does not appear in the swaps covered here. That means it did not trade in `
    + 'one of the 236 tokenized-equity pools during the resolved window — not that it has '
    + 'never traded on this chain.'));
  el('subtable').replaceChildren(box);
}

/** @param {Detail} d */
function renderNoRoundTrips(d) {
  const s = d.summary;
  el('modal-addr').textContent = shortAddr(d.address);
  el('metrics').replaceChildren();
  el('chart-range').replaceChildren();
  el('chart-total').replaceChildren();
  el('subtabs').replaceChildren();
  const stage = el('chart-stage');
  [...stage.children].filter((c) => c.id !== 'tip').forEach((c) => c.remove());

  const rail = el('rail');
  rail.replaceChildren();
  const id = node('div', 'rail-id');
  const names = node('div');
  names.append(node('b', undefined, shortAddr(d.address)));
  names.append(node('small', undefined, d.address));
  id.append(node('span', 'avatar', '◇'), names);
  rail.append(id);

  // No realized figure, and no placeholder pretending to be one.
  const fig = node('div', 'rail-figure');
  fig.append(node('strong', 'muted-figure', 'No realized PnL'));
  fig.append(node('span', undefined, 'no completed round-trips'));
  rail.append(fig);

  rail.append(railBlock('What it did', [
    { key: 'Position changes', value: String(s.position_changes) },
    { key: 'Total volume', value: money(s.total_volume) },
    { key: 'Tokens traded', value: String(s.tokens_traded) },
    { key: 'Sold with no on-chain buy', value: money(s.out_of_scope_volume) },
  ]));

  const box = node('div', 'state-note');
  box.append(node('h3', undefined, d.explain.headline));
  box.append(node('p', undefined, d.explain.detail));
  box.append(node('p', undefined, d.explain.why));
  box.append(node('p', 'dim', d.explain.not_estimated));
  el('subtable').replaceChildren(box);
}

export function closeDetail() {
  el('modal').hidden = true;

}
