/**
 * Page chrome taken from the reference: the search pill's keycap, the sticky status bar,
 * and the podium rank badges.
 *
 * WHAT IS DELIBERATELY ABSENT. The reference's status bar carries a wallet balance and a
 * live connection dot, and its podium carries an account value. We have neither, and an
 * empty shell in the same shape is worse than the space: it advertises a feature that
 * does not exist. The bar carries what this build actually knows about itself.
 */

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * The search pill's keyboard shortcut.
 *
 * The key cap is drawn from the platform rather than hard-coded to the command glyph: a
 * Linux user told to press ⌘K is being told to press a key they do not have.
 * @param {{platform?: string}} [nav]
 */
export function mountSearchShortcut(nav) {
  const cap = el('keycap');
  const input = /** @type {HTMLInputElement} */ (el('search'));
  if (!cap || !input) return;
  const platform = (nav ?? /** @type {any} */ (globalThis).navigator ?? {}).platform ?? '';
  const mac = /mac|iphone|ipad/i.test(String(platform));
  cap.textContent = mac ? '⌘K' : 'Ctrl K';
  input.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');

  document.addEventListener('keydown', (e) => {
    const hit = String(e.key).toLowerCase() === 'k' && (mac ? e.metaKey : e.ctrlKey);
    if (hit) {
      e.preventDefault?.();
      input.focus();
      input.select?.();
      return;
    }
    // Escape gives the field back, which is the other half of a shortcut being usable.
    if (e.key === 'Escape' && document.activeElement === input) input.blur();
  });
}

/**
 * The sticky bottom bar: what this build is, and whether it is this build you are seeing.
 * @param {any} manifest @param {{connected?: string|null}} [state]
 */
export function renderStatusBar(manifest, state = {}) {
  const bar = el('statusbar');
  if (!bar) return;
  bar.replaceChildren();
  const live = Boolean(manifest?.build);
  const dot = node('span', `status-dot ${live ? 'is-live' : 'is-empty'}`);
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', live ? 'Serving a build' : 'No build yet');
  bar.append(dot);
  bar.append(node('span', 'status-item', live ? 'Serving' : 'No build yet'));

  if (live) {
    const b = node('span', 'status-item');
    b.append(node('code', undefined, manifest.build));
    b.title = 'The build this page is reading. It changes when a cycle commits.';
    bar.append(b);
    bar.append(node('span', 'status-sep'));
    bar.append(node('span', 'status-item',
      `${Number(manifest.addresses).toLocaleString('en-US')} addresses`));
    bar.append(node('span', 'status-sep'));
    bar.append(node('span', 'status-item',
      `${Number(manifest.qualifying).toLocaleString('en-US')} with a round-trip`));
  }
  bar.append(node('span', 'spacer'));
  if (state.connected) {
    bar.append(node('span', 'status-item',
      `${state.connected.slice(0, 6)}…${state.connected.slice(-4)}`));
    bar.append(node('span', 'status-sep'));
  }
  const method = node('a', 'status-item');
  method.setAttribute('href', '/method');
  method.textContent = 'Method';
  bar.append(method);
}

/**
 * A podium rank badge. Three ranks in one colour make the order something you read rather
 * than see, so each carries its own metal — and the numeral as well, so colour is never
 * the only channel.
 * @param {number} place
 */
export function rankBadge(place) {
  const b = node('span', `medal medal--${place}`);
  b.append(node('span', 'medal-num', String(place)));
  b.setAttribute('aria-label', `Rank ${place}`);
  return b;
}

/**
 * Overlapping token chips, as the reference stacks them.
 *
 * Overlap is not decoration: it says these belong to one set and bounds the width when an
 * address traded a dozen tokens. The remainder is a count, not a twelfth chip.
 * @param {string[]} tokens @param {number} total
 * @param {(t: string) => HTMLElement} chip
 */
export function stackedChips(tokens, total, chip) {
  const wrap = node('span', 'chipstack');
  const shown = tokens.slice(0, 4);
  shown.forEach((t, i) => {
    const c = chip(t);
    c.classList.add('chipstack-item');
    // Later chips sit under earlier ones, so the leftmost reads as the front of the set.
    c.style.zIndex = String(shown.length - i);
    wrap.append(c);
  });
  if (total > shown.length) {
    wrap.append(node('span', 'chipstack-more', `+${total - shown.length}`));
  }
  wrap.setAttribute('aria-label', total === 1 ? '1 token' : `${total} tokens`);
  return wrap;
}
