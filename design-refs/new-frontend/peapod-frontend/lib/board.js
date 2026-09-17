/**
 * The leaderboard: a podium of three, then the ranking.
 *
 * WHAT THE FRAME SHOWED AND WHAT THIS SHOWS INSTEAD. The frame gives each card and each row
 * an "account value" column. An account value needs every ERC-20 transfer on the chain and a
 * balance engine over it — most holdings here arrived by transfer, issuance or bridge rather
 * than by swap, so swaps alone would show a fraction of an account and call it the whole.
 * The column is therefore matched volume, which is measured, and the card says what it is.
 * Everything else in the frame — the podium, the sort heads, the asset chips, the tape along
 * the bottom — is here as drawn.
 *
 * THE RANKING IS BY REALIZED PnL ON CLOSED ROUND-TRIPS, which is the one number on this page
 * that is not an estimate: bought on-chain, sold on-chain, matched first-in-first-out. An
 * address holding a position that has tripled is not on this board for it, and the note under
 * the table says so rather than letting the ranking imply it is the whole picture.
 */

import { board, meta, assets as allAssets, isSample } from './data.js';
import { mountChrome, mountFoot } from './chrome.js';
import { openProfile } from './profile.js';
import { sparkline } from './spark.js';
import {
  ago, compact, copyButton, el, icon, ICONS, money, node, pct, shortAddr, signed, signedPct,
} from './format.js';

const PAGE = 12;

const state = {
  /** @type {any[]} */ rows: [],
  /** @type {any[]} */ assets: [],
  /** @type {any} */ meta: null,
  tapeEnd: 0,
  universe: 'all',
  window: '7d',
  unit: 'abs',
  sort: 'realized',
  dir: -1,
  query: '',
  limit: PAGE,
  /** @type {{trips: number, win: number, profit: boolean}} */
  filters: { trips: 1, win: 0, profit: false },
};

/* ── the columns. One place, because the head and every row read the same list, and a table
   whose head and body disagree about column four is a table nobody can sort. ───────────── */
/** @type {{key: string, label: string, sortable?: boolean, cell: (r: any) => HTMLElement}[]} */
const COLUMNS = [
  {
    key: 'realized',
    label: 'Realized',
    sortable: true,
    cell: (r) => (state.unit === 'abs' ? signed(r.realized, 'num') : signedPct(r.realizedPct, 'num')),
  },
  {
    key: 'matchedVolume',
    label: 'Matched vol',
    sortable: true,
    cell: (r) => node('span', 'num', compact(r.matchedVolume)),
  },
  {
    key: 'winRate',
    label: 'Win rate',
    sortable: true,
    // Neutral, deliberately. A win rate is a rate, not a direction, and a green 88% beside a
    // green +$1,800 reads as a second gain.
    cell: (r) => node('span', 'num', pct(r.winRate, 1)),
  },
  {
    key: 'roundTrips',
    label: 'Closed',
    sortable: true,
    cell: (r) => node('span', 'num', String(r.roundTrips)),
  },
  {
    key: 'coveragePct',
    label: 'Covered',
    sortable: true,
    // How much of this address's selling had an on-chain buy behind it. The rest has no cost
    // basis and is not scored — which is the single most important caveat on the page.
    cell: (r) => {
      const wrap = node('span', 'covered');
      const bar = node('span', 'covered-track');
      const fill = node('i');
      fill.style.width = `${Math.min(100, r.coveragePct).toFixed(1)}%`;
      bar.append(fill);
      wrap.append(node('span', 'num', pct(r.coveragePct, 0)), bar);
      wrap.title = `${r.coveragePct.toFixed(1)}% of this address's selling had an on-chain buy `
        + 'behind it. The rest has no cost basis and is not scored.';
      return wrap;
    },
  },
];

/** @param {any} r */
function assetChips(r) {
  const wrap = node('div', 'chipstack');
  const shown = r.tokens.slice(0, 3);
  shown.forEach((/** @type {string} */ symbol, /** @type {number} */ i) => {
    const a = state.assets.find((x) => x.symbol === symbol);
    const chip = node('span', `asset-tile asset-tile--${a?.kind ?? 'stock'}`, symbol.slice(0, 2));
    chip.style.zIndex = String(shown.length - i);
    chip.title = a ? `${a.symbol} — ${a.name}` : symbol;
    wrap.append(chip);
  });
  if (r.tokenCount > shown.length) wrap.append(node('span', 'chipstack-more', `+${r.tokenCount - shown.length}`));
  wrap.setAttribute('aria-label', r.tokenCount === 1 ? '1 token traded' : `${r.tokenCount} tokens traded`);
  return wrap;
}

/* ── the podium ─────────────────────────────────────────────────────────────────────────
   Three cards at the top, because the shape of this field is the story: the first row is two
   orders of magnitude above the median. The cards carry the same figures as the rows, larger,
   with the curve beside them. */
/** @param {any} r */
function podiumCard(r) {
  const card = node('button', 'pcard card');
  /** @type {HTMLButtonElement} */ (card).type = 'button';
  card.setAttribute('aria-label', `Open ${shortAddr(r.address)}, rank ${r.rank}`);
  card.onclick = () => openProfile(r.address, card);

  const head = node('div', 'pcard-head');
  head.append(node('span', 'avatar', r.address.slice(2, 4).toUpperCase()));
  const who = node('div', 'pcard-who');
  const line = node('div', 'pcard-addr');
  line.append(node('b', 'mono', shortAddr(r.address)), copyButton(r.address));
  who.append(line, assetChips(r));
  head.append(who);
  head.append(node('span', `medal medal--${r.rank}`, String(r.rank)));
  card.append(head);

  const body = node('div', 'pcard-body');
  const figs = node('div', 'pcard-figs');
  const pnl = node('div', 'pcard-fig');
  pnl.append(state.unit === 'abs' ? signed(r.realized, 'num pcard-num') : signedPct(r.realizedPct, 'num pcard-num'));
  pnl.append(node('span', 'pcard-label', 'Realized · round-trips only'));
  const vol = node('div', 'pcard-fig');
  vol.append(node('strong', 'num pcard-num', compact(r.matchedVolume)));
  vol.append(node('span', 'pcard-label', 'Matched volume'));
  figs.append(pnl, vol);
  // Two facts, not three. The third — how long ago the last close was — did not fit the
  // 168px column at any size worth reading, and it is in the row below and in the profile.
  const foot = node('div', 'pcard-meta');
  foot.append(node('span', undefined, `${r.roundTrips} closed`));
  foot.append(node('span', 'dot-sep', '·'));
  foot.append(node('span', undefined, `${pct(r.winRate, 0)} win`));
  foot.title = `${r.roundTrips} closed round-trips, ${pct(r.winRate, 1)} of them at a profit. `
    + `Last close ${ago(r.lastTs, state.tapeEnd).toLowerCase()}.`;
  figs.append(foot);
  body.append(figs);

  const chart = node('div', 'pcard-chart');
  chart.append(sparkline(r.series, { width: 240, height: 176, dot: true }));
  body.append(chart);
  card.append(body);
  return card;
}

/* ── sorting and filtering ─────────────────────────────────────────────────────────────── */
function visible() {
  const f = state.filters;
  const q = state.query.trim().toLowerCase();
  const rows = state.rows.filter((r) => r.roundTrips >= f.trips
    && r.winRate >= f.win
    && (!f.profit || r.realized > 0)
    && (!q || r.address.toLowerCase().includes(q)));
  const key = state.sort;
  return rows.sort((a, b) => (a[key] - b[key]) * state.dir);
}

function renderPodium() {
  const host = el('podium');
  host.replaceChildren();
  // The podium is the top three OF WHAT IS SHOWING. Filter to addresses with at least ten
  // closes and the podium follows — otherwise the cards and the first three rows disagree,
  // which is the kind of small lie a reader notices and cannot unsee.
  for (const r of visible().slice(0, 3)) host.append(podiumCard(r));
}

function renderHead() {
  const head = el('thead');
  head.replaceChildren();
  head.append(node('div', 'th', 'Rank'));
  head.append(node('div', 'th', 'Trader'));
  for (const c of COLUMNS) {
    if (!c.sortable) { head.append(node('div', 'th th--r', c.label)); continue; }
    const b = node('button', 'th th--r th--sort', c.label);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    const on = state.sort === c.key;
    b.setAttribute('aria-sort', on ? (state.dir === -1 ? 'descending' : 'ascending') : 'none');
    b.append(icon(10, /** @type {any} */ ([
      ['path', { d: 'M1.5 5L5 1.5 8.5 5', 'stroke-width': 1.5,
        opacity: on && state.dir === 1 ? 1 : 0.35 }],
      ['path', { d: 'M1.5 9L5 12.5 8.5 9', 'stroke-width': 1.5,
        opacity: on && state.dir === -1 ? 1 : 0.35 }],
    ]), { viewBox: '0 0 10 14', width: 10, height: 14 }));
    b.onclick = () => {
      // Same column twice flips the direction; a new column starts at the interesting end,
      // which for every column here is the big end.
      if (state.sort === c.key) state.dir = /** @type {1 | -1} */ (state.dir * -1);
      else { state.sort = c.key; state.dir = -1; }
      render();
    };
    head.append(b);
  }
  head.append(node('div', 'th', 'Top assets'));
}

function renderRows() {
  const body = el('rows');
  body.replaceChildren();
  const rows = visible();
  el('empty').hidden = rows.length > 0;
  if (!rows.length) {
    el('empty').textContent = state.query
      ? `No address on this board matches “${state.query.trim()}”.`
      : 'No address matches these filters.';
  }
  for (const r of rows.slice(0, state.limit)) {
    const row = node('button', 'row');
    /** @type {HTMLButtonElement} */ (row).type = 'button';
    row.setAttribute('aria-label', `Open ${shortAddr(r.address)}`);
    row.onclick = () => openProfile(r.address, row);

    const rank = node('div', 'row-rank');
    if (r.rank <= 3) rank.append(node('span', `medal medal--${r.rank}`, String(r.rank)));
    else rank.append(node('span', 'num', String(r.rank)));
    row.append(rank);

    const who = node('div', 'row-who');
    who.append(node('span', 'avatar', r.address.slice(2, 4).toUpperCase()));
    who.append(node('b', 'mono row-addr', shortAddr(r.address)));
    who.append(copyButton(r.address));
    who.append(node('span', 'row-ago', ago(r.lastTs, state.tapeEnd)));
    row.append(who);

    for (const c of COLUMNS) {
      const cell = node('div', 'row-cell');
      cell.append(c.cell(r));
      row.append(cell);
    }
    row.append(assetChips(r));
    body.append(row);
  }
  const more = /** @type {HTMLButtonElement} */ (el('more'));
  more.hidden = rows.length <= state.limit;
  more.textContent = `Show ${Math.min(PAGE, rows.length - state.limit)} more`;
}

function renderNote() {
  const n = el('note');
  n.replaceChildren();
  const qualifying = Number(state.meta?.addressesQualifying ?? 0).toLocaleString('en-US');
  const seen = Number(state.meta?.addressesSeen ?? 0).toLocaleString('en-US');
  n.append(document.createTextNode(
    `Ranked over ${state.meta?.windowLabel ?? 'the window'} of ${state.meta?.chain ?? 'the chain'}. `
    + `${qualifying} of ${seen} addresses closed a round-trip; the rest are holding, and an `
    + 'address is not on this board for a position that has tripled but has not been sold. '
    + 'Realized PnL is matched first-in-first-out on on-chain buys and sells only — units '
    + 'bridged, issued or transferred in have no cost basis and are not scored.'));
}

function render() {
  renderHead();
  renderPodium();
  renderRows();
}

/* ── controls ──────────────────────────────────────────────────────────────────────────── */
/**
 * @param {string} hostId @param {{id: string, label: string}[]} items
 * @param {() => string} get @param {(v: string) => void} set @param {string} [cls]
 */
function segmented(hostId, items, get, set, cls) {
  const host = el(hostId);
  host.replaceChildren();
  for (const item of items) {
    const b = node('button', cls, item.label);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    b.setAttribute('aria-pressed', String(get() === item.id));
    b.onclick = async () => {
      set(item.id);
      state.limit = PAGE;
      for (const other of host.querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      await reload();
    };
    host.append(b);
  }
}

/** The filter chips: each is a <select> wearing the frame's chip, so the keyboard works. */
function renderFilters() {
  const host = el('filters');
  host.replaceChildren();
  /**
   * @param {string} label @param {[string, string][]} options
   * @param {(v: string) => void} onPick
   */
  const chip = (label, options, onPick) => {
    const wrap = node('label', 'chip filterchip');
    wrap.append(node('span', 'filterchip-label', label));
    const sel = node('select');
    for (const [value, text] of options) {
      const o = node('option', undefined, text);
      /** @type {HTMLOptionElement} */ (o).value = value;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      onPick(/** @type {HTMLSelectElement} */ (sel).value);
      state.limit = PAGE;
      render();
    });
    wrap.append(sel);
    wrap.append(icon(14, /** @type {any} */ ([['path', { d: 'M6 9l6 6 6-6' }]]), { 'stroke-width': 2.25 }));
    host.append(wrap);
  };

  chip('Closed round-trips', [['1', 'any'], ['5', '5+'], ['10', '10+'], ['25', '25+']],
    (v) => { state.filters.trips = Number(v); });
  chip('Win rate', [['0', 'any'], ['50', '50%+'], ['60', '60%+'], ['75', '75%+']],
    (v) => { state.filters.win = Number(v); });
  chip('Result', [['all', 'any'], ['profit', 'in profit']],
    (v) => { state.filters.profit = v === 'profit'; });
}

async function reload() {
  const data = await board({ universe: state.universe, window: state.window });
  state.rows = data.rows;
  state.tapeEnd = data.tapeEnd;
  render();
}

/* ── boot ──────────────────────────────────────────────────────────────────────────────── */
state.meta = await meta();
state.assets = await allAssets();

mountChrome(el('chrome'), {
  current: 'leaderboard',
  onSearch: (kind, id) => {
    if (kind === 'trader') openProfile(id);
    else window.location.assign(`/asset.html?symbol=${encodeURIComponent(id)}`);
  },
});
mountFoot(el('foot'), state.meta);

segmented('universes', state.meta.universes, () => state.universe, (v) => { state.universe = v; });
segmented('windows', state.meta.windows, () => state.window, (v) => { state.window = v; });
segmented('units', [{ id: 'abs', label: '$' }, { id: 'pct', label: '%' }],
  () => state.unit, (v) => { state.unit = v; });
renderFilters();
renderNote();

el('filter').addEventListener('input', (e) => {
  state.query = /** @type {HTMLInputElement} */ (e.target).value;
  state.limit = PAGE;
  render();
});
el('more').addEventListener('click', () => { state.limit += PAGE; renderRows(); });

await reload();

// Opened from the search palette on another page: /leaderboard.html?address=0x…
const asked = new URLSearchParams(location.search).get('address');
if (asked && /^0x[0-9a-f]{40}$/i.test(asked)) openProfile(asked.toLowerCase());

if (isSample()) {
  el('hero-sub').append(node('span', 'sample-inline',
    ' Figures on this build are sample data from lib/mock.js.'));
}
