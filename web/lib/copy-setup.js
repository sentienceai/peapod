/**
 * The copy-setup wizard (frame: copy-setup.dc.html) — two configuration steps and a done
 * state, opened over whatever page called openSetup(address).
 *
 * WHAT THE FRAME DREW THAT THIS BUILD DROPS, and why:
 *   - The "Simulated return" chart. The build contract is explicit that nothing here places,
 *     copies OR SIMULATES a trade — a chart plotting "you" against the trader from a made-up
 *     scaling factor is exactly that simulation, just drawn as a line instead of a number.
 *   - The Assets and Settings tabs (per-token toggles, stop loss, take profit, pause-if-
 *     inactive, trade alerts). The task that built this file scopes step 1's configuration to
 *     four rows — max size per trade, include memecoin trades, only copy new positions, max
 *     worse entry — and this file holds to that rather than re-adding the frame's larger
 *     surface.
 *   - Step 2's "Use existing wallet" / "Connect wallet" path and its hardcoded "Available:
 *     2,500.00 USDG" balance. This build has no wallet connection (lib/chrome.js's own Connect
 *     wallet button says so and disables itself) — showing a balance for a wallet nothing here
 *     has connected to would be inventing a number, which is worse than an amount field with
 *     no quick-fill shortcuts.
 *   - The frame's win-rate colour on the stats row (green ≥ 50%, red below). The build
 *     contract's second rule is explicit: "Win rates … stay in the neutral channel, so colour
 *     means direction and only direction." A win rate is not a signed figure, so it is drawn
 *     in the neutral channel here even though the frame colours it.
 *
 * THE ONE THING THIS FILE REFUSES TO FAKE. There is no copy-trade endpoint yet — nothing in
 * lib/data.js documents one, because nothing on the backend accepts one. So Confirm does not
 * flip to a "Copy trade is live" screen the way the frame's does: the done state shows the
 * exact JSON body this configuration would POST, and says, in the page itself, which endpoint
 * it is waiting for (POST /api/copy-trade, chosen to match the REST shape lib/data.js's other
 * endpoints already use — it does not exist, and nothing here pretends otherwise).
 */

import { trader } from './data.js';
import {
  node, icon, ICONS, compact, pct, signed, shortAddr,
} from './format.js';

const clamp = (/** @type {number} */ x, /** @type {number} */ lo, /** @type {number} */ hi) =>
  Math.min(hi, Math.max(lo, x));

/** @param {string} s @returns {number} 0 for anything that doesn't parse, never NaN */
function parseAmount(s) {
  const n = Number.parseFloat(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @typedef {Object} SetupState
 * @property {1 | 2 | 3} step
 * @property {string | null} address
 * @property {any} data trader() detail for the header stats, or null if it never resolved
 * @property {'copy' | 'counter'} mode
 * @property {string[]} extra additional trader addresses copied/countered alongside `address`
 * @property {string} addrInput the "add another trader" field's live text
 * @property {number} maxAlloc percent, 1–50
 * @property {boolean} memes
 * @property {boolean} newOnly
 * @property {number} slippage percent, 0.5–10
 * @property {string} amount live text of the funding-amount field
 * @property {'USDG' | 'ETH'} token
 * @property {Record<string, unknown> | null} requestBody set once Confirm is pressed
 * @property {HTMLElement | null} lastFocus
 * @property {number} seq bumped per open() so a superseded trader() answer never paints over a newer one
 */

/** @type {SetupState} */
const state = {
  step: 1, address: null, data: null, mode: 'copy', extra: [], addrInput: '',
  maxAlloc: 10, memes: false, newOnly: true, slippage: 1, amount: '', token: 'USDG',
  requestBody: null, lastFocus: null, seq: 0,
};

let built = false;
/** @type {HTMLElement} */ let backdropEl;
/** @type {HTMLElement} */ let panelEl;
/** @type {HTMLElement} */ let titleEl;
/** @type {HTMLElement} */ let subEl;
/** @type {HTMLButtonElement} */ let closeBtn;
/** @type {HTMLElement} */ let bodyEl;
/** @type {HTMLButtonElement} */ let primaryBtn;
/** The body's overflow value before the lock, restored on close. @type {string} */
let prevOverflow = '';

const verb = () => (state.mode === 'counter' ? 'Countertrade' : 'Copytrade');
const toneCls = () => (state.mode === 'counter' ? 'down' : 'up');

/**
 * One label/value/control row, the shape every config row in step 1 shares.
 * @param {string} label @param {string} desc
 */
function rowShell(label, desc) {
  const row = node('div', 'wz-row');
  const info = node('div', 'wz-row-info');
  info.append(node('span', 'wz-row-label', label));
  info.append(node('span', 'wz-row-desc', desc));
  row.append(info);
  return row;
}

/**
 * A range control drawn as a RECTANGULAR TRACK BAR, not a round handle — per the house rule
 * that a slider's handle is a control (radius-control-sm), and circles are reserved for things
 * round by nature (avatars, dots, bubbles), which a drag handle is not.
 *
 * The visible fill/handle/number are updated DIRECTLY from the input's own 'input' handler,
 * never by tearing down and rebuilding this row. A full repaint mid-drag would remove the very
 * <input> the pointer has captured, which ends the drag under the person's finger.
 * @param {string} label @param {string} desc @param {'maxAlloc' | 'slippage'} key
 * @param {number} min @param {number} max @param {number} step
 * @param {(v: number) => string} fmt @param {string} unit
 */
function rangeRow(label, desc, key, min, max, step, fmt, unit) {
  const row = rowShell(label, desc);
  const box = node('div', 'wz-range-box');
  const track = node('div', 'wz-range-track');
  const fill = node('div', 'wz-range-fill');
  const handle = node('div', 'wz-range-handle');
  const input = /** @type {HTMLInputElement} */ (node('input', 'wz-range-input'));
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(state[key]);
  input.setAttribute('aria-label', label);
  track.append(fill, handle, input);
  box.append(track);
  const numEl = node('span', 'mono wz-range-value', fmt(state[key]));
  const numWrap = node('div', 'wz-range-num');
  numWrap.append(numEl, node('span', 'wz-range-unit', unit));
  box.append(numWrap);
  row.append(box);

  const paintVal = (/** @type {number} */ v) => {
    const p = clamp(((v - min) / (max - min)) * 100, 0, 100);
    fill.style.width = `${p.toFixed(1)}%`;
    handle.style.left = `calc(${p.toFixed(1)}% - 2px)`;
    numEl.textContent = fmt(v);
  };
  paintVal(/** @type {number} */ (state[key]));
  input.oninput = (e) => {
    const v = Number(/** @type {HTMLInputElement} */ (e.target).value);
    /** @type {any} */ (state)[key] = v;
    paintVal(v);
  };
  return row;
}

/**
 * A boolean row: a rectangular pill track (the track is a shape, not a circle, so it is not
 * covered by the "round by nature" exception) with a small rounded-RECTANGLE knob — the same
 * "handle is a control, controls are rectangles" reasoning as rangeRow(), not the usual round
 * toggle knob.
 * @param {string} label @param {string} desc @param {'memes' | 'newOnly'} key
 */
function toggleRow(label, desc, key) {
  const row = rowShell(label, desc);
  const btn = /** @type {HTMLButtonElement} */ (node('button', 'wz-toggle'));
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.append(node('span', 'wz-toggle-knob'));
  const paintOn = () => {
    const on = !!state[key];
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  };
  paintOn();
  btn.onclick = () => { /** @type {any} */ (state)[key] = !state[key]; paintOn(); };
  row.append(btn);
  return row;
}

/** The three-stat strip at the top of step 1 — every value traced to trader(), never invented. */
function statsRow() {
  const grid = node('div', 'wz-stats');
  const d = state.data;
  const cell = (/** @type {string} */ label, /** @type {Node | string} */ value) => {
    const c = node('div', 'wz-stat');
    c.append(node('span', 'mono wz-stat-label', label));
    const v = node('span', 'wz-stat-value');
    if (typeof value === 'string') v.textContent = value; else v.append(value);
    c.append(v);
    return c;
  };
  grid.append(cell('REALIZED PNL', d ? signed(d.realized, undefined, compact) : '—'));
  // A win rate is not a signed figure — it stays in the neutral channel, unlike the frame,
  // which colours it green/red the same way it colours PnL. See the file header.
  grid.append(cell('WIN RATE', d ? node('span', 'mono', pct(d.winRate, 1)) : '—'));
  grid.append(cell('MATCHED VOLUME', d ? node('span', 'mono', compact(d.matchedVolume)) : '—'));
  return grid;
}

/** Copytrade / Countertrade, a two-way segmented control. */
function modeRow() {
  const wrap = node('div', 'wz-modes');
  for (const [id, label] of /** @type {const} */ ([['copy', 'Copytrade'], ['counter', 'Countertrade']])) {
    const btn = /** @type {HTMLButtonElement} */ (node('button', undefined, label));
    btn.type = 'button';
    const on = state.mode === id;
    btn.className = `wz-mode-btn${on ? ` is-on wz-mode-btn--${id === 'counter' ? 'down' : 'up'}` : ''}`;
    btn.setAttribute('aria-pressed', String(on));
    btn.onclick = () => { if (state.mode !== id) { state.mode = id; paint(); } };
    wrap.append(btn);
  }
  return wrap;
}

/** The trader addresses this run copies or counters together: the base one plus any added. */
function walletsSection() {
  const wrap = node('div', 'wz-wallets');
  wrap.append(node('span', 'mono wz-section-label', 'WALLETS'));
  const chips = node('div', 'wz-wallet-chips');
  const all = [/** @type {string} */ (state.address), ...state.extra];
  all.forEach((addr, i) => {
    const chip = node('span', 'wz-wallet-chip');
    chip.append(node('span', 'avatar avatar--sm mono', addr.slice(2, 4).toUpperCase()));
    chip.append(node('span', 'wz-wallet-name', i === 0 ? 'Trader' : `Trader ${i + 1}`));
    chip.append(node('span', 'mono wz-wallet-addr', shortAddr(addr)));
    if (i > 0) {
      const rm = /** @type {HTMLButtonElement} */ (node('button', 'wz-wallet-remove'));
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove ${shortAddr(addr)}`);
      rm.append(icon(12, ICONS.close));
      rm.onclick = () => { state.extra = state.extra.filter((a) => a !== addr); paint(); };
      chip.append(rm);
    }
    chips.append(chip);
  });
  wrap.append(chips);

  const addRow = node('div', 'wz-add-row');
  const inputWrap = node('label', 'wz-add-field');
  inputWrap.append(node('span', 'sr-only', 'Add another trader address'));
  const input = /** @type {HTMLInputElement} */ (node('input'));
  input.type = 'text';
  input.placeholder = 'Add another trader address (0x…)';
  input.value = state.addrInput;
  input.oninput = (e) => { state.addrInput = /** @type {HTMLInputElement} */ (e.target).value; };
  inputWrap.append(input);
  addRow.append(inputWrap);
  const addBtn = node('button', 'btn wz-add-btn', 'Add');
  /** @type {HTMLButtonElement} */ (addBtn).type = 'button';
  addBtn.onclick = () => {
    const a = state.addrInput.trim();
    const valid = /^0x[0-9a-fA-F]{6,40}$/.test(a);
    const dupe = a.toLowerCase() === String(state.address).toLowerCase()
      || state.extra.some((x) => x.toLowerCase() === a.toLowerCase());
    if (valid && !dupe) { state.extra = state.extra.concat([a]); state.addrInput = ''; paint(); }
  };
  addRow.append(addBtn);
  wrap.append(addRow);
  return wrap;
}

/** Step 1: stats, mode, wallets, and the four configuration rows the task scoped this to. */
function buildStep1() {
  const wrap = node('div', 'wz-step');
  wrap.append(statsRow());
  wrap.append(modeRow());
  wrap.append(walletsSection());
  const config = node('div', 'wz-config');
  config.append(rangeRow('Max size per trade', 'Caps each copied buy as a share of your copy wallet.',
    'maxAlloc', 1, 50, 1, (q) => String(q), '%'));
  config.append(toggleRow('Include memecoin trades', 'Also mirror this trader’s Pons memecoin buys and sells.', 'memes'));
  config.append(toggleRow('Only copy new positions', 'Skip holdings the trader already had before you started.', 'newOnly'));
  config.append(rangeRow('Max worse entry', 'Skip a trade if your price is this much worse than theirs.',
    'slippage', 0.5, 10, 0.5, (q) => q.toFixed(1), '%'));
  wrap.append(config);
  return wrap;
}

/** The funding block: an amount, and which token it is denominated in — USDG or ETH only. */
function fundingBlock() {
  const wrap = node('div', 'wz-funding');
  wrap.append(node('label', 'wz-funding-label', 'Amount'));
  const box = node('div', 'wz-amount-box');
  const input = /** @type {HTMLInputElement} */ (node('input'));
  input.type = 'text';
  input.inputMode = 'decimal';
  input.placeholder = '0.00';
  input.setAttribute('aria-label', 'Funding amount');
  input.value = state.amount;
  input.oninput = (e) => {
    state.amount = /** @type {HTMLInputElement} */ (e.target).value.replace(/[^0-9.,]/g, '');
    // A targeted update, not a repaint: rebuilding this box on every keystroke would tear the
    // <input> the person is typing into out from under their own cursor. Confirm's enabled
    // state is the only other thing this field controls, so it is the only other thing this
    // handler touches.
    primaryBtn.disabled = parseAmount(state.amount) <= 0;
  };
  box.append(input);
  const seg = node('div', 'wz-token-seg');
  for (const id of /** @type {const} */ (['USDG', 'ETH'])) {
    const btn = /** @type {HTMLButtonElement} */ (node('button', undefined, id));
    btn.type = 'button';
    const on = state.token === id;
    btn.className = `wz-token-btn${on ? ' is-on' : ''}`;
    btn.setAttribute('aria-pressed', String(on));
    btn.onclick = () => { if (state.token !== id) { state.token = id; paint(); } };
    seg.append(btn);
  }
  box.append(seg);
  wrap.append(box);
  return wrap;
}

/** A plain-language echo of every setting this run carries, so nothing is confirmed unseen. */
function reviewSection() {
  const wrap = node('div', 'wz-review');
  const rows = /** @type {[string, string][]} */ ([
    ['Mode', verb()],
    ['Wallets copied', String(1 + state.extra.length)],
    ['Max size per trade', `${state.maxAlloc}%`],
    ['Include memecoin trades', state.memes ? 'On' : 'Off'],
    ['Only copy new positions', state.newOnly ? 'On' : 'Off'],
    ['Max worse entry', `${state.slippage.toFixed(1)}%`],
    ['Funding', `${parseAmount(state.amount).toLocaleString('en-US')} ${state.token}`],
  ]);
  for (const [label, value] of rows) {
    const row = node('div', 'wz-review-row');
    row.append(node('span', 'wz-review-label', label));
    row.append(node('span', 'mono wz-review-value', value));
    wrap.append(row);
  }
  return wrap;
}

function buildStep2() {
  const wrap = node('div', 'wz-step');
  wrap.append(fundingBlock());
  wrap.append(node('div', 'wz-section-label mono', 'REVIEW'));
  wrap.append(reviewSection());
  return wrap;
}

/**
 * The request body this configuration would send, in the shape the backend will eventually
 * define. Built once, at Confirm, and never sent — see the file header and buildDone() below.
 */
function buildRequestBody() {
  return {
    action: state.mode,
    traderAddresses: [state.address, ...state.extra],
    config: {
      maxSizePerTradePct: state.maxAlloc,
      includeMemecoinTrades: state.memes,
      onlyCopyNewPositions: state.newOnly,
      maxWorseEntryPct: state.slippage,
    },
    funding: { amount: parseAmount(state.amount), token: state.token },
  };
}

/**
 * THE HONEST DONE STATE. No copy-trade endpoint exists in this build (nothing in lib/data.js
 * documents one), so this cannot say "Copy trade is live" the way the frame does — that would
 * be a control pretending to work. It shows exactly what it would have sent and where.
 */
function buildDone() {
  const wrap = node('div', 'wz-done');
  wrap.append(node('span', 'wz-done-icon', '—'));
  wrap.append(node('h3', 'wz-done-title', 'Nothing has been placed'));
  wrap.append(node('p', 'wz-done-body',
    `This build has no ${state.mode === 'counter' ? 'countertrade' : 'copytrade'} endpoint yet. `
    + 'Below is exactly the request this configuration would send once one exists — no trade '
    + 'has been copied, countered, or simulated.'));
  const endpoint = node('div', 'wz-endpoint');
  endpoint.append(node('span', undefined, 'Waiting on '));
  endpoint.append(node('code', 'mono', 'POST /api/copy-trade'));
  wrap.append(endpoint);
  const pre = node('pre', 'wz-json');
  pre.append(node('code', 'mono', JSON.stringify(state.requestBody, null, 2)));
  wrap.append(pre);
  return wrap;
}

function renderHead() {
  if (!state.address) return;
  titleEl.textContent = state.step === 3 ? 'Nothing has been placed' : `${verb()} ${shortAddr(state.address)}`;
  subEl.textContent = state.step === 1 ? 'Configure your trading preferences'
    : state.step === 2 ? 'Configure funding, then review every setting before confirming.'
      : 'This build has no backend endpoint yet — see below.';
}

function renderBody() {
  bodyEl.replaceChildren(state.step === 1 ? buildStep1() : state.step === 2 ? buildStep2() : buildDone());
}

function renderFoot() {
  const foot = /** @type {HTMLElement} */ (panelEl.querySelector('.wz-foot'));
  foot.replaceChildren();

  if (state.step < 3) {
    const track = node('div', 'wz-progress-track');
    const fill = node('div', 'wz-progress-fill');
    fill.style.width = state.step === 1 ? '50%' : '100%';
    fill.classList.add(toneCls());
    track.append(fill);
    foot.append(track);
    foot.append(node('span', 'mono wz-progress-label', `${state.step}/2`));
  }
  foot.append(node('span', 'spacer'));

  if (state.step < 3) {
    const secondaryBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn wz-secondary',
      state.step === 1 ? 'Cancel' : 'Back'));
    secondaryBtn.type = 'button';
    secondaryBtn.onclick = () => {
      if (state.step === 1) closeSetup();
      else { state.step = 1; paint(); }
    };
    foot.append(secondaryBtn);
  }

  primaryBtn = /** @type {HTMLButtonElement} */ (node('button', `btn-copy btn-copy--lg wz-primary wz-primary--${toneCls()}`,
    state.step === 1 ? 'Continue' : state.step === 2 ? 'Confirm' : 'Close'));
  primaryBtn.type = 'button';
  if (state.step === 2) primaryBtn.disabled = parseAmount(state.amount) <= 0;
  primaryBtn.onclick = () => {
    if (state.step === 1) { state.step = 2; paint(); }
    else if (state.step === 2) {
      if (parseAmount(state.amount) <= 0) return;
      // Validate, then FREEZE the request as of this click — Confirm reads state once here,
      // not lazily inside buildDone(), so a value changed after Confirm (nothing lets you get
      // back to step 1 once past this point) can never disagree with what buildDone() shows.
      state.requestBody = buildRequestBody();
      state.step = 3;
      paint();
    } else {
      closeSetup();
    }
  };
  foot.append(primaryBtn);
}

function paint() {
  renderHead();
  renderBody();
  renderFoot();
}

/** Every focusable element currently visible inside the panel, in DOM order. */
function focusable() {
  return Array.from(panelEl.querySelectorAll(
    'button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])',
  )).filter((n) => /** @type {HTMLElement} */ (n).offsetParent !== null);
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSetup(); return; }
  if (e.key !== 'Tab') return;
  const items = focusable();
  if (items.length === 0) return;
  const first = /** @type {HTMLElement} */ (items[0]);
  const last = /** @type {HTMLElement} */ (items[items.length - 1]);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** Builds the static shell exactly once; every open() re-fills it via paint(). */
function build() {
  if (built) return;
  built = true;

  backdropEl = node('div', 'backdrop');
  backdropEl.hidden = true;
  backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) closeSetup(); });

  panelEl = node('div', 'wz-panel');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.addEventListener('keydown', onKeydown);

  const head = node('div', 'wz-head');
  const headText = node('div', 'wz-head-text');
  titleEl = node('span', 'wz-title');
  subEl = node('span', 'wz-sub');
  headText.append(titleEl, subEl);
  head.append(headText);
  closeBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn-ghost'));
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close copy setup');
  closeBtn.append(icon(16, ICONS.close));
  closeBtn.onclick = () => closeSetup();
  head.append(closeBtn);
  panelEl.append(head);

  bodyEl = node('div', 'wz-body');
  panelEl.append(bodyEl);
  panelEl.append(node('div', 'wz-foot'));

  backdropEl.append(panelEl);
  document.body.append(backdropEl);
}

/**
 * Opens the wizard for `address`, resetting every field to its default — a reopened wizard
 * starts clean rather than carrying a previous trader's slider positions into a new one.
 * @param {string} address
 */
export async function openSetup(address) {
  build();
  const seq = ++state.seq;
  Object.assign(state, {
    step: 1, address, data: null, mode: 'copy', extra: [], addrInput: '',
    maxAlloc: 10, memes: false, newOnly: true, slippage: 1, amount: '', token: 'USDG',
    requestBody: null,
  });
  state.lastFocus = typeof (/** @type {any} */ (document.activeElement))?.focus === 'function'
    ? /** @type {any} */ (document.activeElement) : null;

  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  backdropEl.hidden = false;
  paint();
  closeBtn.focus();

  let d = null;
  try {
    d = await trader(address);
  } catch {
    // Same reasoning as lib/profile.js: a dropped request reads as "no history to show" in the
    // stats row (already handled by statsRow()'s `d ? … : '—'`), not a stuck dialog.
    d = null;
  }
  if (seq !== state.seq) return; // superseded by a later openSetup() before this resolved
  state.data = d;
  if (state.step === 1) renderBody(); // only the stats row reads `data`, so that's all this repaints
}

/** Closes the wizard, unlocks scroll, and returns focus to whatever opened it. */
export function closeSetup() {
  if (!built || backdropEl.hidden) return;
  backdropEl.hidden = true;
  document.body.style.overflow = prevOverflow;
  const back = state.lastFocus;
  state.lastFocus = null;
  if (back && document.contains(back)) back.focus();
}
