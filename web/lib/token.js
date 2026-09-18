/**
 * Token identity: a logo where we have one, initials where we do not.
 *
 * The tile itself is built by format.js's assetTile(); this module owns the map, the
 * filename check and the one listener that clears an image which failed to load.
 *
 * The tile always renders its initials and the image is appended over them; on `load` the
 * initials are hidden, and on `error` the image removes itself and they stay. That order is
 * deliberate: a 404, a corrupt cache entry, a blocked request or an image that simply never
 * arrives all leave the letters showing, and only a logo that actually painted takes their
 * place. Layering the two and hoping the art is opaque is what drew "SBPR" for SPY.
 *
 * TWO LISTENERS, NOT TWO PER IMAGE. Neither `load` nor `error` bubbles, but both propagate
 * through the capture phase, so one capturing listener each catches every token image on the
 * page, including ones added later by the modal. Binding per image means remembering to
 * bind, and the failure mode of forgetting is invisible until an image breaks in production.
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

/**
 * The <img> for a ticker, or null where we have no file for it.
 * @param {string} ticker @returns {HTMLImageElement | null}
 */
export function tokenLogo(ticker) {
  const file = LOGOS[String(ticker).toUpperCase()] ?? LOGOS[ticker];
  // Only a name this module produced: the map is ours, but a filename is still
  // interpolated into a URL, so it has to look like one of ours before it is.
  if (typeof file !== 'string' || !/^0x[0-9a-f]{40}\.(png|jpg|jpeg|webp)$/.test(file)) return null;
  const img = document.createElement('img');
  img.setAttribute('data-token-logo', '');
  img.setAttribute('src', `/token-logos/${file}`);
  img.setAttribute('alt', '');
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.setAttribute('width', '32');
  img.setAttribute('height', '32');
  return img;
}

/** Whether an event's target is one of our logo images. @param {any} t */
const isLogo = (t) => Boolean(t && t.tagName === 'IMG' && t.hasAttribute?.('data-token-logo'));

if (typeof document !== 'undefined' && document.addEventListener) {
  // Matched on the attribute and the tag rather than `instanceof HTMLImageElement`, so the
  // same code path is exercised by the tests as by the browser.
  document.addEventListener('error', (e) => {
    const t = /** @type {any} */ (e.target);
    if (isLogo(t)) t.remove();
  }, true);
  document.addEventListener('load', (e) => {
    const t = /** @type {any} */ (e.target);
    // The class, not a style: the tile keeps its letters in the DOM (they are what comes
    // back if the image is ever removed) and CSS stops drawing them.
    if (isLogo(t)) t.parentNode?.classList?.add('has-logo');
  }, true);
}
