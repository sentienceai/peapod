/**
 * The search palette — ⌘K / "/" opens it (bound in lib/chrome.js), it asks lib/data.js for
 * matches, and it hands the pick back to whoever opened it.
 *
 * BUILT ONCE, LAZILY. The panel is a single DOM subtree appended to <body> on first open and
 * reused after that: a palette that gets rebuilt every keystroke is a palette that steals
 * focus and resets scroll on every keystroke.
 *
 * ONE FOCUSED ELEMENT, NOT ONE PER ROW. The search field keeps focus for the whole session;
 * rows are `role="option"` divs, never buttons, and the active one is tracked with
 * `aria-activedescendant` (the standard combobox-listbox pattern). Up/Down/Enter all read the
 * one active index, so every row is reachable from the keyboard without moving DOM focus
 * fifty times a second while someone holds an arrow key down.
 *
 * ONE LINE PER ROW, NOT TWO. The frame's rows are 44px tall. "A line of context" for a
 * trader — `N closed · NN% win` — reads as one more inline phrase after the address, the
 * same rhythm the asset row already uses for ticker + name, rather than a second stacked
 * line that would need a taller row the frame never draws.
 */

import { search } from './data.js';
import {
  ICONS, assetTile, compact, icon, money, node, pct, price, shortAddr, signed,
} from './format.js';

/** @typedef {{symbol: string, name: string, kind: string, price: number, change24h: number}} AssetHit */
/** @typedef {{address: string, realized: number, winRate: number, roundTrips: number}} TraderHit */
/** @typedef {(kind: 'asset' | 'trader', id: string) => void} OnPick */

let builtPanel = false;

/** @type {HTMLElement} */ let backdropEl;
/** @type {HTMLElement} */ let panelEl;
/** @type {HTMLInputElement} */ let inputEl;
/** @type {HTMLElement} */ let listEl;
/** @type {HTMLElement} */ let emptyEl;
/** @type {HTMLElement} */ let emptyQEl;
/** @type {Record<'assets' | 'traders', {btn: HTMLElement, count: HTMLElement}>} */
let tabEls;

const state = {
  /** @type {'assets' | 'traders'} */ tab: /** @type {'assets' | 'traders'} */ ('assets'),
  query: '',
  /** @type {{assets: AssetHit[], traders: TraderHit[], direct: string | null}} */
  results: { assets: [], traders: [], direct: null },
  active: 0,
  /** @type {OnPick | null} */ onPick: null,
  /** @type {HTMLElement | null} */ lastFocus: null,
  // Bumped on every keystroke so a slow, stale search() response can never overwrite what a
  // newer one already rendered.
  seq: 0,
};

/** The flat, on-screen list for whichever tab is current — traders gets `direct` appended. */
function currentList() {
  if (state.tab === 'assets') return state.results.assets;
  /** @type {(TraderHit & {direct?: false})[]} */
  const list = state.results.traders.slice();
  if (state.results.direct) list.push(/** @type {any} */ ({ address: state.results.direct, direct: true }));
  return list;
}

/** No caller-supplied `onPick`: this is what the button in the top bar gets by default. */
function defaultPick(/** @type {'asset' | 'trader'} */ kind, /** @type {string} */ id) {
  location.href = kind === 'asset'
    ? `/asset.html?symbol=${encodeURIComponent(String(id).toUpperCase())}`
    : `/leaderboard.html?address=${encodeURIComponent(String(id).toLowerCase())}`;
}

function pick(/** @type {'asset' | 'trader'} */ kind, /** @type {string} */ id) {
  const cb = state.onPick ?? defaultPick;
  closeSearch();
  cb(kind, id);
}

/** First two hex characters after "0x" — the only thing this app knows about an address to show. */
const initials = (/** @type {string} */ addr) => addr.slice(2, 4).toUpperCase();

/** @param {AssetHit} a @param {number} i */
function assetRow(a, i) {
  const row = node('div', 'search-row');
  row.id = `search-row-${i}`;
  row.setAttribute('role', 'option');
  const main = node('div', 'search-row-main');
  main.append(assetTile(a.symbol, a.kind), node('span', 'search-row-sym', a.symbol),
    node('span', 'search-row-name', a.name));
  row.append(main);
  const figs = node('div', 'search-row-figs');
  figs.append(node('span', 'mono search-row-price', price(a.price)));
  figs.append(signed(a.change24h, 'mono search-row-chg', (x) => pct(x, 2)));
  row.append(figs);
  // A plain div isn't focusable, but a mousedown on it still blurs whatever WAS focused (the
  // search field). Swallowing it keeps the caret and the field's aria-activedescendant intact
  // right up to the click.
  row.onmousedown = (e) => e.preventDefault();
  row.onclick = () => pick('asset', a.symbol);
  row.onmouseenter = () => { state.active = i; updateActive(); };
  return row;
}

/** @param {TraderHit & {direct?: boolean}} t @param {number} i */
function traderRow(t, i) {
  const row = node('div', `search-row search-row--trader${t.direct ? ' search-row--direct' : ''}`);
  row.id = `search-row-${i}`;
  row.setAttribute('role', 'option');
  const main = node('div', 'search-row-main');
  main.append(node('span', 'avatar avatar--sm', initials(t.address)),
    node('span', 'mono search-row-addr', shortAddr(t.address)));
  if (t.direct) {
    // A complete address a person typed that never closed a round-trip: data.js still knows
    // its address, so it is offered, but labelled — a search that only shows what is on the
    // board says "no results" for the one thing it actually can see.
    main.append(node('span', 'search-row-tag', 'Not on board'));
    row.append(main, node('span', 'search-row-hint', 'Open profile'));
  } else {
    main.append(node('span', 'search-row-ctx', `${t.roundTrips} closed · ${pct(t.winRate, 0)} win`));
    row.append(main, signed(t.realized, 'mono search-row-realized', compact));
  }
  row.onmousedown = (e) => e.preventDefault();
  row.onclick = () => pick('trader', t.address);
  row.onmouseenter = () => { state.active = i; updateActive(); };
  return row;
}

/** Paint the active row: the highlight, `aria-selected`, and the field's activedescendant. */
function updateActive() {
  const rows = listEl.children;
  for (let i = 0; i < rows.length; i++) {
    const on = i === state.active;
    rows[i].classList.toggle('is-active', on);
    rows[i].setAttribute('aria-selected', String(on));
  }
  const activeRow = /** @type {HTMLElement | undefined} */ (rows[state.active]);
  if (activeRow) {
    inputEl.setAttribute('aria-activedescendant', activeRow.id);
    activeRow.scrollIntoView({ block: 'nearest' });
  } else {
    inputEl.removeAttribute('aria-activedescendant');
  }
}

function renderTabs() {
  const counts = /** @type {const} */ ({
    assets: state.results.assets.length,
    traders: state.results.traders.length + (state.results.direct ? 1 : 0),
  });
  for (const id of /** @type {const} */ (['assets', 'traders'])) {
    const on = state.tab === id;
    tabEls[id].btn.classList.toggle('is-active', on);
    tabEls[id].btn.setAttribute('aria-selected', String(on));
    tabEls[id].count.textContent = String(counts[id]);
  }
}

function renderList() {
  const list = currentList();
  state.active = Math.min(state.active, Math.max(0, list.length - 1));
  listEl.replaceChildren();
  listEl.scrollTop = 0;
  if (list.length === 0) {
    listEl.hidden = true;
    emptyEl.hidden = false;
    emptyQEl.textContent = `“${state.query}”`;
    inputEl.removeAttribute('aria-activedescendant');
    return;
  }
  emptyEl.hidden = true;
  listEl.hidden = false;
  list.forEach((item, i) => {
    listEl.append(state.tab === 'assets' ? assetRow(/** @type {AssetHit} */ (item), i)
      : traderRow(/** @type {TraderHit & {direct?: boolean}} */ (item), i));
  });
  updateActive();
}

/** @param {string} q */
async function runSearch(q) {
  state.query = q;
  const seq = ++state.seq;
  let res;
  try {
    res = await search(q);
  } catch {
    // A dropped request reads as "nothing matched" rather than a stuck spinner: the palette
    // has no loading state to show, and pretending an error is a shorter list is worse.
    res = { assets: [], traders: [], direct: null };
  }
  if (seq !== state.seq) return; // a later keystroke's answer has already landed
  state.results = res;
  state.active = 0;
  renderTabs();
  renderList();
}

/** @param {'assets' | 'traders'} id */
function switchTab(id) {
  if (state.tab === id) return;
  state.tab = id;
  state.active = 0;
  renderTabs();
  renderList();
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  const list = currentList();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.active = Math.min(state.active + 1, Math.max(0, list.length - 1));
    updateActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.active = Math.max(state.active - 1, 0);
    updateActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = list[state.active];
    if (!item) return;
    if (state.tab === 'assets') pick('asset', /** @type {AssetHit} */ (item).symbol);
    else pick('trader', /** @type {TraderHit} */ (item).address);
  } else if (e.key === 'Tab') {
    // The palette has exactly two destinations, so Tab and Shift+Tab do the same thing: they
    // never leave the dialog, because there is nothing after it to tab to.
    e.preventDefault();
    switchTab(state.tab === 'assets' ? 'traders' : 'assets');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
}

/** The decorative pea-pod mark the footer carries, matching the one in the top bar. */
function footMark() {
  const svg = icon(20, /** @type {any} */ ([
    ['rect', { x: 2, y: 9, width: 26, height: 12, rx: 6 }],
    ['circle', { cx: 9, cy: 15, r: 3 }],
    ['circle', { cx: 15, cy: 15, r: 3 }],
    ['circle', { cx: 21, cy: 15, r: 3 }],
  ]), { viewBox: '0 0 30 30', fill: 'none', stroke: 'none' });
  svg.classList.add('search-mark');
  return svg;
}

/** Constructs the panel exactly once; every later `openSearch` reuses it. */
function build() {
  if (builtPanel) return;
  builtPanel = true;

  backdropEl = node('div', 'backdrop');
  backdropEl.hidden = true;
  backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) closeSearch(); });

  panelEl = node('div', 'search-panel');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.setAttribute('aria-label', 'Search');
  // A fallback for Escape: normally the field itself has focus and handles this, but a click
  // on the ESC button or a tab first moves focus there, and Escape should still close.
  panelEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });

  const field = node('div', 'search-field');
  field.append(icon(20, ICONS.search));
  inputEl = /** @type {HTMLInputElement} */ (node('input'));
  inputEl.type = 'search';
  inputEl.placeholder = 'Search assets, addresses or trader names';
  inputEl.setAttribute('aria-label', 'Search assets or addresses');
  inputEl.setAttribute('role', 'combobox');
  inputEl.setAttribute('aria-expanded', 'true');
  inputEl.setAttribute('aria-controls', 'search-listbox');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.oninput = (e) => runSearch(/** @type {HTMLInputElement} */ (e.target).value);
  inputEl.addEventListener('keydown', onKeydown);
  field.append(inputEl);
  const esc = node('button', 'search-esc', 'ESC');
  /** @type {HTMLButtonElement} */ (esc).type = 'button';
  esc.setAttribute('aria-label', 'Close search');
  esc.onclick = () => closeSearch();
  field.append(esc);
  panelEl.append(field);

  const tabsRow = node('div', 'search-tabs');
  tabsRow.setAttribute('role', 'tablist');
  tabsRow.setAttribute('aria-label', 'Result type');
  tabEls = /** @type {any} */ ({});
  for (const [id, label] of /** @type {const} */ ([['assets', 'Assets'], ['traders', 'Traders']])) {
    const btn = node('button', 'search-tab');
    /** @type {HTMLButtonElement} */ (btn).type = 'button';
    btn.setAttribute('role', 'tab');
    btn.id = `search-tab-${id}`;
    const count = node('span', 'mono search-tab-count', '0');
    btn.append(node('span', undefined, label), count);
    btn.onclick = () => { switchTab(id); inputEl.focus(); };
    tabsRow.append(btn);
    tabEls[id] = { btn, count };
  }
  panelEl.append(tabsRow);

  listEl = node('div', 'search-list');
  listEl.id = 'search-listbox';
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Results');
  panelEl.append(listEl);

  emptyEl = node('div', 'search-empty');
  emptyEl.hidden = true;
  const title = node('div', 'search-empty-title');
  title.append(document.createTextNode('No matches for '));
  emptyQEl = node('span', 'search-empty-q');
  title.append(emptyQEl);
  emptyEl.append(title,
    node('div', 'search-empty-hint', 'Try a ticker like TSLA, a name, or paste a full 0x address.'));
  panelEl.append(emptyEl);

  const foot = node('div', 'search-foot');
  const hints = /** @type {const} */ ([
    [['↑', '↓'], 'Navigate'], [['↵'], 'Open'], [['Tab'], 'Switch tab'], [['Esc'], 'Close'],
  ]);
  for (const [keys, label] of hints) {
    const g = node('span', 'search-hint');
    for (const k of keys) g.append(node('span', 'search-key', k));
    g.append(document.createTextNode(label));
    foot.append(g);
  }
  foot.append(node('span', 'spacer'), footMark());
  panelEl.append(foot);

  backdropEl.append(panelEl);
  document.body.append(backdropEl);
}

/**
 * Opens the palette. `onPick` gets `('asset', 'TSLA')` or `('trader', '0x…')`; leaving it out
 * makes the palette navigate there itself.
 * @param {{onPick?: OnPick}} [opts]
 */
export function openSearch(opts = {}) {
  build();
  state.onPick = opts.onPick ?? null;
  state.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.tab = 'assets';
  inputEl.value = '';
  backdropEl.hidden = false;
  runSearch('');
  inputEl.focus();
}

/** Closes the palette and returns focus to whatever had it before `openSearch`. */
export function closeSearch() {
  if (!builtPanel || backdropEl.hidden) return;
  backdropEl.hidden = true;
  const back = state.lastFocus;
  state.lastFocus = null;
  if (back && document.contains(back)) back.focus();
}
