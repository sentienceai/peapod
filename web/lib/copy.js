/**
 * Copy-to-clipboard for addresses.
 *
 * An address is the one thing on this page nobody retypes: it is 42 characters and a
 * single wrong one points at a different person. Every place an address is shown, it can
 * be taken.
 *
 * THE CONFIRMATION IS THE POINT. A copy that silently does nothing is worse than no
 * button, because the person walks away believing they have the address. So the button
 * reports what happened: a tick when the clipboard accepted it, a cross when it did not.
 * `navigator.clipboard` is undefined on an insecure origin and rejects when permission is
 * refused, and both are states a real person hits — neither is swallowed.
 *
 * HOVER IS NOT THE ONLY WAY IN. On leaderboard rows the button is revealed on hover to
 * keep the table quiet, but hover does not exist for a keyboard or a touchscreen, so the
 * CSS reveals it on focus as well and shows it unconditionally where hover is absent.
 *
 * THE ROW UNDERNEATH IS A LINK. Copying must not also open the modal, so the button stops
 * both the click and the Enter/Space keydown from reaching the row that wraps it.
 */

const REVERT_MS = 1200;

/** @param {string} cls @param {string} [text] */
function span(cls, text) {
  const n = document.createElement('span');
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} text @returns {Promise<void>} */
async function write(text) {
  const clip = /** @type {any} */ (globalThis.navigator)?.clipboard;
  if (!clip?.writeText) throw new Error('clipboard unavailable');
  await clip.writeText(text);
}

/**
 * @param {string} address
 * @param {{ label?: string }} [opts]
 * @returns {HTMLElement}
 */
export function copyButton(address, opts = {}) {
  const b = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  b.className = 'copy';
  b.type = 'button';
  const what = opts.label ?? 'address';
  b.setAttribute('aria-label', `Copy ${what} ${address}`);
  b.title = `Copy ${what}`;

  const glyph = span('copy-glyph', '⧉');
  // role=status so the outcome is announced, not only drawn. A tick that only exists as
  // a colour change is not a confirmation for anyone who cannot see it.
  const live = span('copy-live');
  live.setAttribute('role', 'status');
  b.append(glyph, live);

  /** @type {any} */
  let timer = null;
  /** @param {string} mark @param {string} said @param {string} cls */
  function settle(mark, said, cls) {
    glyph.textContent = mark;
    live.textContent = said;
    b.className = `copy ${cls}`;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      glyph.textContent = '⧉';
      live.textContent = '';
      b.className = 'copy';
    }, REVERT_MS);
  }

  b.onclick = (e) => {
    e.stopPropagation?.();
    e.preventDefault?.();
    return write(address).then(
      () => settle('✓', 'Copied', 'is-ok'),
      () => settle('✕', 'Copy failed', 'is-fail'),
    );
  };
  // Enter and Space on the button would otherwise also reach the row and open the modal.
  b.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation?.();
  };
  return b;
}
