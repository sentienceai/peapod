/**
 * Token identity: a logo where we have one, initials where we do not.
 *
 * The tile is always rendered and the image sits on top of it. Nothing is conditional on
 * the image loading, so a 404, a corrupt cache entry or a blocked request reveals the
 * tile underneath rather than leaving a gap or a broken-image glyph.
 *
 * ONE LISTENER, NOT ONE PER IMAGE. An `error` event does not bubble, but it does
 * propagate through the capture phase, so a single capturing listener on the document
 * catches every token image on the page, including ones added later by the modal. Binding
 * per image means remembering to bind, and the failure mode of forgetting is invisible
 * until an image breaks in production.
 *
 * TICKERS, NOT ADDRESSES. The shipped data names tokens by ticker; the logo files are
 * named by contract address. The map between them is built at export time and only for
 * tickers that resolve to exactly one address. Four tokens share the ticker "P", and
 * guessing which of them a row means would put the wrong company's logo on a trade.
 */

/** @type {Record<string, string>} */
let LOGOS = {};

/** @param {Record<string, string>} map ticker -> logo filename */
export function setTokenLogos(map) {
  LOGOS = map ?? {};
}

/** @param {string} ticker */
function initials(ticker) {
  return (ticker || '?').slice(0, 2).toUpperCase();
}

/**
 * A token as it appears in a table cell: mark, then ticker.
 * @param {string} ticker
 * @param {string} [cls] extra class on the wrapper
 * @returns {HTMLElement}
 */
export function tokenCell(ticker, cls) {
  const wrap = document.createElement('span');
  wrap.className = cls ? `token ${cls}` : 'token';

  const icon = document.createElement('span');
  icon.className = 'token-icon';
  const tile = document.createElement('span');
  tile.className = 'token-tile';
  tile.textContent = initials(ticker);
  icon.append(tile);

  const file = LOGOS[ticker];
  // Only a name this module produced: the map is ours, but a filename is still
  // interpolated into a URL, so it has to look like one of ours before it is.
  if (typeof file === 'string' && /^0x[0-9a-f]{40}\.(png|jpg|jpeg|webp)$/.test(file)) {
    const img = document.createElement('img');
    img.setAttribute('data-token-logo', '');
    img.setAttribute('src', `/token-logos/${file}`);
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('width', '32');
    img.setAttribute('height', '32');
    icon.append(img);
  }

  const label = document.createElement('span');
  label.className = 'token-ticker';
  label.textContent = ticker;
  wrap.append(icon, label);
  return wrap;
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('error', (e) => {
    const t = /** @type {HTMLElement | null} */ (e.target);
    // Matched on the attribute and the tag rather than `instanceof HTMLImageElement`,
    // so the same code path is exercised by the tests as by the browser.
    if (t && t.tagName === 'IMG' && t.hasAttribute?.('data-token-logo')) t.remove();
  }, true);
}
