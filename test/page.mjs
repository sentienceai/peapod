/**
 * Boot one of the site's pages in the stub DOM, against the real store.
 *
 * The pages are ES modules with top-level await that mount themselves on import, so a test
 * "opens" a page by installing its markup and importing its module — exactly the order a
 * browser does it in. Everything the modules touch that the stub does not provide (the
 * theme's documentElement, localStorage, matchMedia, history, location) is supplied here
 * rather than in each test, so a page that starts using one more of them fails in one place
 * with a clear message.
 *
 * ONE DOCUMENT AT A TIME. install() replaces the global document, so a test file may boot
 * one page and must finish with it before booting another. Tests that drive a page keep to
 * the file that booted it.
 */

import { install } from './dom-stub.mjs';

/**
 * @param {string} page the html file's basename, e.g. 'leaderboard'
 * @param {string} mod the module in web/lib to import, e.g. 'board'
 * @param {{ search?: string, settle?: number }} [opts]
 */
export async function openPage(page, mod, opts = {}) {
  const search = opts.search ?? '';
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: `/${page}`, search, href: `http://stub/${page}${search}`, assign() {} },
  });
  /** @type {Record<string, string>} */
  const stored = {};
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (/** @type {string} */ k) => stored[k] ?? null,
      setItem: (/** @type {string} */ k, /** @type {string} */ v) => { stored[k] = v; } },
  });
  globalThis.history = /** @type {any} */ ({ pushState() {}, replaceState() {} });
  globalThis.matchMedia = /** @type {any} */ (() => ({ matches: false, addEventListener() {} }));

  const installed = await install(new URL(`../web/${page}.html`, import.meta.url));
  /** @type {Record<string, string>} */
  const attrs = {};
  const doc = /** @type {any} */ (globalThis.document);
  doc.documentElement = {
    setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => { attrs[k] = v; },
    getAttribute: (/** @type {string} */ k) => attrs[k] ?? null,
    dataset: {},
  };
  // A real node, not a placeholder: the dialogs mount themselves on document.body, and a
  // body that throws what it is given makes every dialog untestable.
  doc.body = doc.createElement('body');
  doc.body.style = {};

  await import(`../web/lib/${mod}.js`);
  // The modules paint from data they awaited at import; give the microtasks a turn.
  await new Promise((r) => { setTimeout(r, opts.settle ?? 400); });
  return { ...installed, attrs, doc };
}

/** Every descendant carrying a class, as a flat list. @param {any} root @param {string} cls */
export const byClass = (root, cls) => root.descendants()
  .filter((/** @type {any} */ n) => String(n.className).split(' ').includes(cls));

/** The text of a node with every unwired slot removed. @param {any} root */
export function wiredText(root) {
  /** @param {any} n @returns {string} */
  const walk = (n) => (typeof n === 'string' ? n
    : String(n.className).split(' ').includes('unwired') ? '' : n.children.map(walk).join(''));
  return walk(root);
}

/** Every unwired slot under a node. @param {any} root */
export const slots = (root) => byClass(root, 'unwired');

/**
 * Every signed figure under a node, checked for all three channels.
 * @param {any} root @returns {string[]} what is wrong, empty when nothing is
 */
export function signChannels(root) {
  /** @type {string[]} */
  const wrong = [];
  const signed = root.descendants()
    // Elements that carry a sign class without carrying a FIGURE — the win/loss squares, a
    // legend swatch — are the sign channel used as a key, not as a number. They are
    // allowlisted in the stylesheet and checked there; here, only figures apply.
    .filter((/** @type {any} */ n) => /(^|\s)(up|down)(\s|$)/.test(n.className || '')
      && String(n.textContent).trim() !== '');
  for (const cell of signed) {
    const glyph = byClass(cell, 'mark');
    if (glyph.length !== 1) { wrong.push(`no direction glyph: ${cell.textContent}`); continue; }
    const isUp = /(^|\s)up(\s|$)/.test(cell.className);
    if (glyph[0].textContent !== (isUp ? '▲' : '▼')) wrong.push(`wrong glyph: ${cell.textContent}`);
    const rest = cell.textContent.replace(glyph[0].textContent, '');
    if (!/^[+−]/.test(rest)) wrong.push(`no sign character: ${cell.textContent}`);
    else if (rest.startsWith('−') !== !isUp) wrong.push(`sign disagrees with class: ${rest}`);
  }
  return wrong;
}
