/**
 * The trader profile pop-up (frame: trader-profile.dc.html).
 *
 * WHY TWO RAILS, NOT THE FRAME'S ONE. The frame stacks "Holdings / Overview / Analysis /
 * Performance" in a single 300px aside, because its mock trader owns priced holdings (a
 * portfolio value, a cost basis, an unrealized PnL). This board's data model has none of
 * that — trader() answers with closed round-trips, matched volume and a realized curve, not
 * a live portfolio — so "Holdings" and "Overview" have nothing to render. What is left,
 * Analysis and Performance, becomes two rails flanking the centre column instead of one:
 * the dialog opens near full-screen, there is room, and a wallet's trading BEHAVIOUR
 * (style, hold times, quote mix) reads better apart from its RESULTS (the win-rate band,
 * coverage, the daily ledger) than stacked under one heading.
 *
 * WHY NO TRACK / ALERTS / CLAIM. The frame draws all three in the aside. None has a field
 * behind it in trader() — there is no "is this address tracked", no alert subscription, no
 * claim flow — and a button with no state to reflect is exactly the "control pretending to
 * work" the build contract rules out. They are dropped rather than wired to nothing.
 *
 * WHY THE CHART HAS NO RANGE OR METRIC TOGGLE. The frame's chart switches between four
 * ranges and two metrics (PnL vs account value) because its mock invents a fresh series per
 * combination. trader() returns exactly one series: the realized-PnL curve over the tape's
 * window. Drawing four range buttons over one series would be UI that promises data this
 * page cannot produce.
 *
 * A NOTE ON THE WIN-RATE WIDGET. It answers "is this win rate different from a coin flip",
 * not "is this trader good" — a copy score belongs to copy-setup.js, not here. See
 * evidence.js for the maths: the exact binomial region, one implementation site-wide.
 */

import { trader } from './data.js';
import { chanceBand, CRITERION } from './evidence.js';
import { realizedDrawdown, returnOnMatchedCost } from './figures.js';
import { unwired } from './needs.js';
import { areaChart } from './spark.js';
import {
  node, icon, ICONS, signed, signedPct, money, price, compact, pct, duration, stamp, shortAddr,
  copyButton, token,
} from './format.js';

/**
 * @typedef {Object} Trader
 * @property {number} [rank] only when the dialog was opened from a ranking
 * @property {string} address
 * @property {number} realized @property {number} realizedPct
 * @property {number} matchedVolume @property {number} totalVolume
 * @property {number} matchedSharePct @property {number} outOfScopeVolume @property {number} coveragePct
 * @property {number} winRate @property {number} wins @property {number} roundTrips
 * @property {string[]} tokens @property {number} tokenCount
 * @property {number} lastTs @property {number} medianHoldS @property {number} avgHoldS
 * @property {number} longestWinStreak @property {string} style @property {number} percentile
 * @property {{quote: string, pct: number, volume: number}[]} quoteMix
 * @property {number[]} sequence @property {[number, number][]} series @property {string[]} universes
 * @property {{symbol: string, kind: string, qty: number, buy: number, sell: number, heldS: number, closedTs: number, realized: number}[]} roundTripList
 * @property {{ts: number, symbol: string, kind: string, side: string, qty: number, price: number, value: number}[]} trades
 * @property {{symbol: string, kind: string, roundTrips: number, winRate: number, matched: number, realized: number}[]} tokenStats
 * @property {{day: string, roundTrips: number, winRate: number, realized: number}[]} daily
 * @property {{id: string, label: string, criteria: string, earned: boolean}[]} [labels] each
 *   with the rule that earns it — a label without its criteria is a vibe
 * @property {{depth: number, peak: number, trough: number, from_ts: number | null,
 *   to_ts: number | null, closes: number} | null} [realizedDrawdown] computed by the build
 *   over every close, because the shipped curve is downsampled
 * @property {number} [positionChanges] buys and sells, for an address that closed nothing
 * @property {string} [status] @property {{headline: string, detail: string,
 *   not_estimated: string} | null} [explain] present when the address closed nothing
 */

const clamp = (/** @type {number} */ x, /** @type {number} */ lo, /** @type {number} */ hi) =>
  Math.min(hi, Math.max(lo, x));

/**
 * A token quantity, unsigned and without a currency sign. format.js's `compact()` LOOKS like
 * a generic compact-number formatter but always prepends "$" — it is a dollar formatter, and
 * using it on a meme balance in the tens of thousands would print it as tens of thousands of
 * dollars. Kept local rather than added to format.js: this build's contract is not to touch
 * shared files, and no other page needs a bare quantity formatted this way yet.
 * @param {number} n
 */
function qty(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `${s}${a.toFixed(a >= 1 ? 2 : 4)}`;
}

let built = false;
/** @type {HTMLElement} */ let backdropEl;
/** @type {HTMLElement} */ let panelEl;
/** @type {HTMLElement} */ let headEl;
/** @type {HTMLElement} */ let bodyEl;
/** @type {HTMLButtonElement} */ let closeBtn;

const state = {
  /** @type {string | null} */ address: null,
  /** @type {Trader | null} */ data: null,
  /** @type {TabId} */ tab: 'roundtrips',
  /** @type {HTMLElement | null} */ lastFocus: null,
  /** Bumped per open() so a slow, superseded trader() answer can never paint over a newer one. */
  seq: 0,
  /** The body's overflow value before the lock, restored on close. */
  prevOverflow: '',
};

/**
 * The win-rate slot: an observed rate on a neutral track, the chance band shaded behind it,
 * and the verdict in words. Built on .ev / .ev-track / .ev-band / .ev-mark from base.css —
 * the same "region and a mark, never a fill from the left" primitive the evidence bar
 * already established, because a win rate is a test result here, not a score to fill toward.
 * @param {number} winRate percent, 0–100 @param {number} wins @param {number} roundTrips
 */
function winRateBand(winRate, wins, roundTrips) {
  // The exact binomial region from web/lib/evidence.js — one implementation for the whole
  // site. See the note in copy-page.js: the approximation this replaced reported a one-in-
  // eight result as one-in-twenty, and below six closes it invented a verdict where the test
  // has no power at all.
  const b = chanceBand(wins, roundTrips);

  // .ev-head is a nowrap flex row (base.css) sized for a bolded figure and a short label —
  // the wins/closes count goes in .ev-foot instead, so this widget doesn't overflow the
  // narrowest place it sits (a 240px rail) with a sentence that row was never sized for.
  const wrap = node('div', 'ev');
  const head = node('div', 'ev-head');
  head.append(node('b', undefined, pct(winRate, 1)));
  head.append(document.createTextNode('win rate'));
  wrap.append(head);

  const track = node('div', 'ev-track');
  const band = node('div', 'ev-band');
  band.style.left = `${b.lo * 100}%`;
  band.style.width = `${(b.hi - b.lo) * 100}%`;
  const nullMark = node('div', 'ev-null');
  const mark = node('div', 'ev-mark');
  mark.style.left = `${b.rate * 100}%`;
  track.append(band, nullMark, mark);
  wrap.append(track);

  // NEUTRAL, always. A beyond-chance loser and a beyond-chance winner are opposite news, and
  // the words say which; borrowing the up/down channel to say it again would spend the sign
  // colour on something that has no sign. The direction is already in the mark's position
  // relative to the drawn null.
  wrap.append(node('div', `ev-verdict${b.decisive ? ' ev-verdict-strong' : ''}`, b.label));

  const foot = node('div', 'ev-foot',
    `${wins} of ${roundTrips} closes · chance ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`);
  foot.title = CRITERION;
  wrap.append(foot);
  return wrap;
}

/** A trading-style / universe tag, same shape as the frame's small pills. @param {string} text */
function tag(text) {
  return node('span', 'profile-tag', text);
}

/**
 * The rank chip in the header. A numeral, never a colour alone, per the house rule that a
 * rank carries its numeral — this board has no name to put in an avatar, so the rank is it.
 * @param {number} rank
 */
function rankChip(rank) {
  return node('span', 'profile-rank mono', `#${rank}`);
}

/** A neutral two-part share bar: filled portion vs. the rest, no direction implied. @param {number} pctFilled 0–100 */
function shareBar(pctFilled) {
  const track = node('div', 'profile-bar');
  const fill = node('div', 'profile-bar-fill');
  fill.style.width = `${clamp(pctFilled, 0, 100)}%`;
  track.append(fill);
  return track;
}

/** One label/value row for a rail. @param {string} label @param {string | Node} value */
function railRow(label, value) {
  const row = node('div', 'profile-rail-row');
  row.append(node('span', 'profile-rail-label', label));
  const v = node('span', 'profile-rail-value');
  if (typeof value === 'string') v.textContent = value; else v.append(value);
  row.append(v);
  return row;
}

/** @param {Trader} d */
function analysisRail(d) {
  const rail = node('aside', 'profile-rail');
  rail.append(node('h3', 'profile-rail-title', 'Analysis'));
  rail.append(railRow('Trading style', d.style));
  rail.append(railRow('Avg hold time', node('span', 'mono', duration(d.avgHoldS))));
  rail.append(railRow('Median hold time', node('span', 'mono', duration(d.medianHoldS))));
  rail.append(railRow('Longest win streak', node('span', 'mono', `${d.longestWinStreak}`)));
  rail.append(railRow('Percentile', node('span', 'mono', `${d.percentile.toFixed(1)}th`)));
  rail.append(railRow('Tokens traded', node('span', 'mono', `${d.tokenCount}`)));

  const chips = node('div', 'profile-chips');
  for (const sym of d.tokens.slice(0, 8)) {
    const kind = (d.tokenStats.find((t) => t.symbol === sym) || {}).kind
      ?? d.roundTripList.find((p) => p.symbol === sym)?.kind ?? 'stock';
    chips.append(token({ symbol: sym, kind }));
  }
  rail.append(chips);

  if (d.quoteMix.length) {
    rail.append(node('div', 'profile-rail-sub', 'Quote mix'));
    rail.append(shareBar(d.quoteMix[0].pct));
    const legend = node('div', 'profile-legend');
    for (const q of d.quoteMix) {
      legend.append(node('span', 'mono', `${q.quote} ${pct(q.pct, 0)} · ${compact(q.volume)}`));
    }
    rail.append(legend);
  }
  return rail;
}

/** @param {Trader} d */
function performanceRail(d) {
  const rail = node('aside', 'profile-rail');
  rail.append(node('h3', 'profile-rail-title', 'Performance'));
  rail.append(winRateBand(d.winRate, d.wins, d.roundTrips));

  rail.append(node('div', 'profile-rail-sub', 'Volume matched'));
  rail.append(shareBar(d.coveragePct));
  rail.append(node('div', 'profile-legend',
    `${compact(d.matchedVolume)} matched · ${compact(d.outOfScopeVolume)} out of scope`));
  rail.append(railRow('Share of total volume', node('span', 'mono', pct(d.matchedSharePct, 1))));
  rail.append(railRow('Realized vs. matched', signedPct(d.realizedPct)));
  rail.append(railRow('Last close', node('span', 'mono', stamp(d.lastTs, { time: true }))));

  /*
   * TWO FIGURES THIS DATA SUPPORTS, NAMED FOR WHAT THEY MEASURE — and, beside them, the two
   * account-level figures the frame asked for, which need the transfer index.
   *
   *   Realized drawdown   the deepest fall of the closed-round-trip curve, in dollars,
   *                       computed by the build over every close (the shipped curve is
   *                       downsampled, so a figure taken from it would be a floor).
   *   Return on matched   realized over the cost of the buys that were matched. The cost is
   *                       exact: matched volume is cost + proceeds and realized is proceeds
   *                       − cost. It is not account ROI — capital in open positions, or
   *                       never deployed, is not in the denominator.
   */
  const dd = realizedDrawdown(d.series, { realized_drawdown: d.realizedDrawdown, round_trips: d.roundTrips });
  rail.append(railRow('Realized drawdown', node('span', 'mono',
    dd.depth > 0 ? `${dd.exact ? '' : 'at least '}−${money(dd.depth)}` : 'None')));
  rail.append(node('div', 'profile-legend', dd.depth > 0
    ? `Deepest fall of the realized curve${dd.exact ? '' : `, on a ${dd.points}-point sample`}, over ${dd.closes} closes. Not account drawdown.`
    : `Never below its own peak over ${dd.closes} closes. Not account drawdown.`));
  const roc = returnOnMatchedCost({ realized: d.realized, matched_volume: d.matchedVolume });
  if (roc) {
    rail.append(railRow('Return on matched cost', signedPct(roc.pct)));
    rail.append(node('div', 'profile-legend',
      `On ${compact(roc.cost)} of matched buys. Not account ROI.`));
  }
  const gaps = node('div', 'profile-gaps');
  for (const key of /** @type {const} */ (['accountValue', 'roi', 'drawdown', 'sharpe'])) {
    gaps.append(unwired(key, { compact: true }));
  }
  rail.append(gaps);

  /*
   * THE LABELS, EACH WITH THE RULE THAT EARNS IT. A label with no stated criterion is a
   * vibe: "smart money" was refused for exactly this reason, and these four are only worth
   * showing because the build ships what each one means.
   */
  if (d.labels?.length) {
    rail.append(node('div', 'profile-rail-sub', 'Labels'));
    const labels = node('div', 'profile-labels');
    for (const l of d.labels) {
      const item = node('div', 'profile-label');
      item.dataset.earned = String(Boolean(l.earned));
      item.append(node('b', undefined, l.label), node('small', undefined, l.criteria));
      labels.append(item);
    }
    rail.append(labels);
  }

  rail.append(node('div', 'profile-rail-sub', 'Last 7 days'));
  const mini = node('div', 'profile-mini');
  for (const day of d.daily) {
    const ts = Math.floor(Date.parse(`${day.day}T00:00:00Z`) / 1000);
    const r = node('div', 'profile-mini-row');
    r.append(node('span', 'mono', stamp(ts)));
    r.append(node('span', 'mono', `${day.roundTrips}rt`));
    r.append(node('span', 'mono', pct(day.winRate, 0)));
    r.append(signed(day.realized, 'mono', compact));
    mini.append(r);
  }
  rail.append(mini);
  return rail;
}

/**
 * One metric card. `body` receives the card's content area to fill — kept generic because
 * the four cards on this row share nothing but their frame (a 40px titled head, 14px body).
 * @param {string} title @param {(body: HTMLElement) => void} fill
 */
function metricCard(title, fill) {
  const card = node('div', 'profile-card');
  const head = node('div', 'profile-card-head');
  head.append(node('span', undefined, title));
  card.append(head);
  const body = node('div', 'profile-card-body');
  fill(body);
  card.append(body);
  return card;
}

/** @param {Trader} d */
function metricsRow(d) {
  const grid = node('div', 'profile-metrics');

  grid.append(metricCard('Realized PnL', (body) => {
    body.append(signed(d.realized, 'profile-card-value', money));
    const squares = node('div', 'profile-card-squares');
    squares.style.gridTemplateColumns = `repeat(${Math.max(1, d.sequence.length)}, minmax(0, 1fr))`;
    for (const w of d.sequence) squares.append(node('div', `profile-card-square ${w ? 'up' : 'down'}`));
    const sr = node('span', 'sr-only', `${d.wins} wins of ${d.roundTrips} closes`);
    body.append(squares, sr);
    body.append(node('div', 'profile-card-foot',
      `${pct(d.winRate, 1)} win rate · ${d.roundTrips} round trips`));
  }));

  grid.append(metricCard('Volume matched', (body) => {
    body.append(node('span', 'profile-card-value', pct(d.coveragePct, 1)));
    body.append(shareBar(d.coveragePct));
    body.append(node('div', 'profile-card-foot',
      `${compact(d.matchedVolume)} matched of ${compact(d.totalVolume)} total`));
  }));

  grid.append(metricCard('Win rate', (body) => {
    body.append(winRateBand(d.winRate, d.wins, d.roundTrips));
  }));

  grid.append(metricCard('Tokens & activity', (body) => {
    body.append(node('span', 'profile-card-value', `${d.tokenCount}`));
    const chips = node('div', 'profile-chips');
    for (const sym of d.tokens.slice(0, 6)) {
      const kind = d.tokenStats.find((t) => t.symbol === sym)?.kind ?? 'stock';
      chips.append(token({ symbol: sym, kind }));
    }
    if (d.tokens.length > 6) chips.append(node('span', 'profile-more', `+${d.tokens.length - 6}`));
    body.append(chips);
    body.append(node('div', 'profile-card-foot',
      `Last close ${stamp(d.lastTs)} · ${d.style}`));
  }));

  return grid;
}

/** @param {Trader} d */
function chartPanel(d) {
  const panel = node('div', 'profile-chart-panel');
  const head = node('div', 'profile-card-head');
  head.append(node('span', undefined, 'Realized PnL'));
  panel.append(head);

  const body = node('div', 'profile-chart-body');
  body.append(node('div', 'profile-chart-title', 'Cumulative, over the tape window'));
  const valueEl = node('div', 'profile-chart-value');
  body.append(valueEl);

  const last = d.series[d.series.length - 1];
  // spark.js hands the hovered point back as a plain [x, y] number[], so that is what this
  // takes; it reads the two slots either way.
  const paint = (/** @type {number[] | null} */ p) => {
    const point = p ?? last;
    valueEl.replaceChildren(signed(point ? point[1] : d.realized, undefined, money));
    valueEl.append(node('span', 'profile-chart-ts',
      point ? stamp(point[0], { time: true }) : ''));
  };
  const chart = areaChart(d.series, { onHover: paint });
  paint(null);
  body.append(chart);
  panel.append(body);
  return panel;
}

/**
 * @typedef {'roundtrips' | 'trades' | 'tokens' | 'performance'} TabId
 * @typedef {{label: string, align?: 'right', cell: (r: any) => string | HTMLElement}} Column
 * @typedef {Trader['roundTripList'] | Trader['trades'] | Trader['tokenStats'] | Trader['daily']} TabRows
 * @typedef {{id: TabId, label: string, divider?: boolean, rows: (d: Trader) => TabRows,
 *            cols: Column[]}} TabDef
 */

/**
 * Column definitions per sub-tab: label, alignment, and how to render one row's cell.
 * @type {TabDef[]}
 */
const TAB_DEFS = [
  {
    // NOT "Positions". A position is something held, and this build cannot see holdings
    // at all — every row here is a CLOSED round-trip. The frame's word would promise the
    // one table this data can never fill.
    id: 'roundtrips', label: 'Round-trips', rows: (/** @type {Trader} */ d) => d.roundTripList,
    cols: [
      { label: 'Asset', cell: (/** @type {any} */ r) => token(r) },
      { label: 'Qty', align: 'right', cell: (/** @type {any} */ r) => qty(r.qty) },
      { label: 'Buy', align: 'right', cell: (/** @type {any} */ r) => price(r.buy) },
      { label: 'Sell', align: 'right', cell: (/** @type {any} */ r) => price(r.sell) },
      { label: 'Held', align: 'right', cell: (/** @type {any} */ r) => duration(r.heldS) },
      { label: 'Closed', align: 'right', cell: (/** @type {any} */ r) => stamp(r.closedTs) },
      { label: 'Realized', align: 'right', cell: (/** @type {any} */ r) => signed(r.realized, undefined, money) },
    ],
  },
  {
    id: 'trades', label: 'Trades', rows: (/** @type {Trader} */ d) => d.trades,
    cols: [
      { label: 'Time', cell: (/** @type {any} */ r) => stamp(r.ts, { time: true }) },
      { label: 'Asset', cell: (/** @type {any} */ r) => token(r) },
      { label: 'Side', cell: (/** @type {any} */ r) => node('span', `profile-side profile-side--${r.side}`, r.side) },
      { label: 'Qty', align: 'right', cell: (/** @type {any} */ r) => qty(r.qty) },
      { label: 'Price', align: 'right', cell: (/** @type {any} */ r) => price(r.price) },
      { label: 'Value', align: 'right', cell: (/** @type {any} */ r) => money(r.value) },
    ],
  },
  {
    id: 'tokens', label: 'Tokens', rows: (/** @type {Trader} */ d) => d.tokenStats,
    cols: [
      { label: 'Asset', cell: (/** @type {any} */ r) => token(r) },
      { label: 'Round trips', align: 'right', cell: (/** @type {any} */ r) => `${r.roundTrips}` },
      { label: 'Win rate', align: 'right', cell: (/** @type {any} */ r) => pct(r.winRate, 1) },
      { label: 'Matched', align: 'right', cell: (/** @type {any} */ r) => compact(r.matched) },
      { label: 'Realized', align: 'right', cell: (/** @type {any} */ r) => signed(r.realized, undefined, money) },
    ],
  },
  {
    id: 'performance', label: 'Performance', divider: true, rows: (/** @type {Trader} */ d) => d.daily,
    cols: [
      { label: 'Day', cell: (/** @type {any} */ r) => stamp(Math.floor(Date.parse(`${r.day}T00:00:00Z`) / 1000)) },
      { label: 'Round trips', align: 'right', cell: (/** @type {any} */ r) => `${r.roundTrips}` },
      { label: 'Win rate', align: 'right', cell: (/** @type {any} */ r) => pct(r.winRate, 1) },
      { label: 'Realized', align: 'right', cell: (/** @type {any} */ r) => signed(r.realized, undefined, money) },
    ],
  },
];

/**
 * The sub-tab table: a tablist, a header row and the body rows for whichever tab is active.
 * Rebuilt on every tab switch rather than diffed — the column count changes per tab, and
 * this table is rebuilt at most a few times per profile open.
 * @param {Trader} d
 */
function tablePanel(d) {
  const panel = node('div', 'profile-table-panel');

  const tabs = node('div', 'profile-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Trader detail');
  const tableBody = node('div', 'profile-table-body');

  const paintTable = () => {
    const active = TAB_DEFS.find((t) => t.id === state.tab) ?? TAB_DEFS[0];
    for (const child of Array.from(tabs.children)) {
      // Duck-typed rather than `instanceof HTMLButtonElement`: the same code path is then
      // exercised by the tests as by the browser, and an <a> acting as a tab would work too.
      if (!/(^|\s)profile-tab(\s|$)/.test(String(/** @type {any} */ (child).className))) continue;
      const on = /** @type {any} */ (child).dataset.tab === active.id;
      child.setAttribute('aria-selected', String(on));
    }
    tableBody.replaceChildren();
    const rows = active.rows(d);

    const template = active.cols.map(() => 'minmax(0, 1fr)').join(' ');
    const thead = node('div', 'profile-thead');
    thead.style.gridTemplateColumns = template;
    for (const col of active.cols) {
      thead.append(node('div', `profile-th${col.align === 'right' ? ' right' : ''}`, col.label));
    }
    tableBody.append(thead);

    if (rows.length === 0) {
      tableBody.append(node('div', 'profile-empty', `No ${active.label.toLowerCase()} in this window.`));
      return;
    }
    const list = node('div', 'profile-rows');
    for (const row of rows) {
      const tr = node('div', 'profile-trow');
      tr.style.gridTemplateColumns = template;
      for (const col of active.cols) {
        const td = node('div', `profile-td${col.align === 'right' ? ' right' : ''}`);
        const v = col.cell(row);
        if (typeof v === 'string') td.textContent = v; else td.append(v);
        tr.append(td);
      }
      list.append(tr);
    }
    tableBody.append(list);
  };

  for (const def of TAB_DEFS) {
    if (def.divider) tabs.append(node('div', 'profile-tab-divider'));
    const btn = /** @type {HTMLButtonElement} */ (node('button', 'profile-tab', def.label));
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = def.id;
    const count = def.rows(d).length;
    if (count > 0) btn.append(node('span', 'profile-tab-count', String(count)));
    btn.onclick = () => { state.tab = def.id; paintTable(); };
    tabs.append(btn);
  }

  panel.append(tabs, tableBody);
  paintTable();
  return panel;
}

/** @param {Trader} d */
function buildContent(d) {
  bodyEl.replaceChildren();
  bodyEl.append(analysisRail(d));
  const center = node('div', 'profile-center');
  center.append(metricsRow(d), chartPanel(d), tablePanel(d));
  bodyEl.append(center, performanceRail(d));
}

/** The plain state for an address `trader()` cannot find on this board. @param {string} address */
/** @param {string} address @param {Trader | null} [d] */
function buildNotFound(address, d) {
  bodyEl.replaceChildren();
  const box = node('div', 'profile-notfound');

  /*
   * TWO DIFFERENT ANSWERS, AND THEY ARE NOT THE SAME.
   *
   * `d` null means the tape has never seen this address at all. `d.status ===
   * 'no_round_trips'` means it traded here and never closed — which is the commoner case by
   * far: about 73,900 of the 103,920 addresses in this window. Collapsing the second into
   * "not on this board" throws away everything the build knows about it, so the build's own
   * explanation is shown instead, along with what it DID do.
   */
  if (d?.status === 'no_round_trips') {
    box.append(node('h3', undefined, 'Traded, but nothing closed'));
    for (const line of [d.explain?.headline, d.explain?.detail, d.explain?.not_estimated]) {
      if (line) box.append(node('p', undefined, line));
    }
    const facts = node('div', 'profile-mini');
    /** @param {string} label @param {string} value */
    const fact = (label, value) => {
      const r = node('div', 'profile-mini-row');
      r.append(node('span', undefined, label), node('span', 'mono', value));
      facts.append(r);
    };
    if (d.positionChanges) fact('Position changes', String(d.positionChanges));
    if (d.totalVolume) fact('Volume traded', compact(d.totalVolume));
    if (d.outOfScopeVolume) fact('Sold with no on-chain buy', compact(d.outOfScopeVolume));
    if (d.tokenCount) fact('Tokens traded', String(d.tokenCount));
    // No realized figure at all, rather than a zero: a zero here would read as "broke even",
    // and what happened is that nothing was closed to measure.
    box.append(facts);
    bodyEl.append(box);
    return;
  }

  box.append(node('h3', undefined, 'Not in this tape'));
  box.append(node('p', undefined,
    `${shortAddr(address)} did not trade in these pools in this window. That is not the same `
    + 'as never having traded: the build folds one window of one chain, and an address '
    + 'outside it is invisible here rather than absent from the chain.'));
  bodyEl.append(box);
}

/** Every button/link/input inside the panel that can currently take focus, in DOM order. */
function focusable() {
  return Array.from(panelEl.querySelectorAll(
    'button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])',
  )).filter((el) => /** @type {HTMLElement} */ (el).offsetParent !== null);
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeProfile(); return; }
  if (e.key !== 'Tab') return;
  const items = focusable();
  if (items.length === 0) return;
  const first = /** @type {HTMLElement} */ (items[0]);
  const lastItem = /** @type {HTMLElement} */ (items[items.length - 1]);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastItem.focus(); }
  else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); first.focus(); }
}

/** Constructs the static shell exactly once; every open() re-fills it. */
function build() {
  if (built) return;
  built = true;

  backdropEl = node('div', 'backdrop');
  backdropEl.hidden = true;
  backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) closeProfile(); });

  panelEl = node('div', 'profile-panel');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.setAttribute('aria-label', 'Trader profile');
  panelEl.addEventListener('keydown', onKeydown);

  headEl = node('div', 'profile-head');
  panelEl.append(headEl);
  bodyEl = node('div', 'profile-body');
  panelEl.append(bodyEl);

  backdropEl.append(panelEl);
  document.body.append(backdropEl);
}

/** The header: identity, the copy-warning slot, the "Copy this trader" action and Close. */
function buildHead(/** @type {string} */ address, /** @type {Trader | null} */ d) {
  headEl.replaceChildren();

  const id = node('div', 'profile-head-id');
  if (d && Number.isFinite(d.rank)) id.append(rankChip(/** @type {number} */ (d.rank)));
  const addrWrap = node('span', 'profile-addr mono');
  addrWrap.append(document.createTextNode(shortAddr(address)));
  addrWrap.append(copyButton(address, 'address'));
  id.append(addrWrap);
  if (d) {
    const tags = node('div', 'profile-tags');
    tags.append(tag(d.style));
    for (const u of d.universes) tags.append(tag(u === 'stocks' ? 'Stocks' : 'Memecoins'));
    id.append(tags);
  }
  headEl.append(id);

  headEl.append(node('span', 'spacer'));

  const warn = node('span', 'profile-copy-warn');
  warn.hidden = true;
  headEl.append(warn);

  if (d) {
    const copyBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn-copy btn-copy--lg', 'Copy this trader'));
    copyBtn.type = 'button';
    copyBtn.onclick = async () => {
      // Dynamic import so a missing or broken copy-setup.js (written by another agent, in
      // parallel with this file) cannot take the profile dialog down with it — the worst
      // case is this button saying so, not a blank page.
      try {
        const mod = await import('./copy-setup.js');
        if (typeof mod.openSetup !== 'function') throw new Error('openSetup missing');
        warn.hidden = true;
        mod.openSetup(address);
      } catch {
        warn.hidden = false;
        warn.textContent = 'Copy setup is not available right now.';
      }
    };
    headEl.append(copyBtn);
  }

  closeBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn-ghost'));
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close trader profile');
  closeBtn.append(icon(18, ICONS.close));
  closeBtn.onclick = () => closeProfile();
  headEl.append(closeBtn);
}

/**
 * Opens the profile dialog for `address` and loads its detail from lib/data.js.
 * @param {string} address @param {HTMLElement} [from] focus returns here on close
 */
export async function openProfile(address, from) {
  build();
  const seq = ++state.seq;
  state.address = address;
  state.tab = 'roundtrips';
  state.lastFocus = from ?? (typeof (/** @type {any} */ (document.activeElement))?.focus === 'function'
    ? /** @type {any} */ (document.activeElement) : null);

  state.prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  backdropEl.hidden = false;

  buildHead(address, null);
  bodyEl.replaceChildren(node('div', 'profile-loading', 'Loading trader…'));
  closeBtn.focus();

  let d = null;
  try {
    d = await trader(address);
  } catch {
    // A dropped request reads as "not on this board" rather than a stuck spinner, same
    // reasoning as the search palette: an admitted gap beats a spinner that never resolves.
    d = null;
  }
  if (seq !== state.seq) return; // superseded by a later openProfile() before this resolved

  state.data = d;
  // buildHead() replaces the close button's DOM node (it may not exist yet on the first
  // call, when there's no copy button to size against). If it held focus a moment ago, that
  // focus just fell off the removed node onto <body> — put it back on the new one, or the
  // trap in onKeydown has nothing inside the panel to bounce between.
  const hadFocus = panelEl.contains(document.activeElement) || document.activeElement === document.body;
  buildHead(address, d);
  if (d && d.status !== 'no_round_trips') buildContent(d); else buildNotFound(address, d);
  if (hadFocus) closeBtn.focus();
}

/** Closes the dialog, unlocks scroll, and returns focus to whatever opened it. */
export function closeProfile() {
  if (!built || backdropEl.hidden) return;
  backdropEl.hidden = true;
  document.body.style.overflow = state.prevOverflow;
  state.data = null;
  const back = state.lastFocus;
  state.lastFocus = null;
  if (back && document.contains(back)) back.focus();
}
