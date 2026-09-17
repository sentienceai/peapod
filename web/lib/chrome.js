/**
 * The top bar, built once and mounted by every page.
 *
 * It is a module rather than markup repeated in four HTML files because the four would drift
 * — a nav item added in three places, a search button that opens the palette on two pages
 * and does nothing on the third. Each page says which nav item is current and gets the rest.
 *
 * The search control is a BUTTON that opens the palette, not an input. An input in the bar
 * that hands your keystrokes to a dialog is an input that eats the first two of them.
 */

import { mountTheme } from './theme.js';
import { mountWallet } from './wallet-ui.js';
import { icon, ICONS, node } from './format.js';
import { openSearch } from './search.js';

const NAV = [
  { id: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
  { id: 'copy', label: 'Copy trade', href: '/copy-trade' },
  { id: 'markets', label: 'Markets', href: '/markets' },
];

/** The pea-pod mark: three peas in a pod, the one place the accent is decoration. */
function brandMark() {
  const svg = icon(30, /** @type {any} */ ([
    ['rect', { x: 2, y: 9, width: 26, height: 12, rx: 6 }],
    ['circle', { cx: 9, cy: 15, r: 3 }],
    ['circle', { cx: 15, cy: 15, r: 3 }],
    ['circle', { cx: 21, cy: 15, r: 3 }],
  ]), { viewBox: '0 0 30 30', width: 30, height: 30, fill: 'currentColor', stroke: 'none' });
  svg.classList.add('brand-mark');
  return svg;
}

/**
 * @param {HTMLElement | null} host
 * @param {{current?: string, onSearch?: (kind: string, id: string) => void}} [opts]
 */
export function mountChrome(host, opts = {}) {
  if (!host) return;
  host.className = 'topbar';
  host.replaceChildren();

  const brand = node('a', 'brand');
  /** @type {HTMLAnchorElement} */ (brand).href = '/';
  brand.append(brandMark(), node('span', 'brand-name', 'Peapod'));
  host.append(brand);

  const nav = node('nav', 'nav');
  nav.setAttribute('aria-label', 'Main');
  for (const item of NAV) {
    const a = node('a', undefined, item.label);
    /** @type {HTMLAnchorElement} */ (a).href = item.href;
    if (item.id === opts.current) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  host.append(nav);

  const search = node('button', 'navsearch');
  /** @type {HTMLButtonElement} */ (search).type = 'button';
  search.setAttribute('aria-label', 'Search assets or addresses');
  search.append(icon(17, ICONS.search));
  search.append(node('span', undefined, 'Search assets, addresses or names'));
  search.append(node('span', 'keycap', '/'));
  search.onclick = () => openSearch(opts.onSearch ? { onPick: opts.onSearch } : {});
  host.append(search);

  host.append(node('div', 'spacer'));

  const themeHost = node('div', 'theme-host');
  host.append(themeHost);
  mountTheme(themeHost);

  // Connect only — see lib/wallet-ui.js. The control asks a wallet for its addresses and
  // nothing else, and what it buys is one thing: a way into your own address's profile.
  const wallet = node('div', 'wallet-host');
  mountWallet(wallet);
  host.append(wallet);

  // "/" opens search from anywhere, as the keycap in the bar promises.
  document.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (/^(input|textarea|select)$/i.test(t?.tagName ?? '')) return;
    if (e.key === '/' || (String(e.key).toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      openSearch(opts.onSearch ? { onPick: opts.onSearch } : {});
    }
  });
}

/**
 * The footer: what this build is, and what it is made of. The sample-data mark lives here
 * and on every page that shows a figure, because the alternative is a plausible number with
 * nothing behind it.
 * @param {HTMLElement | null} host @param {any} meta
 */
export function mountFoot(host, meta) {
  if (!host) return;
  host.className = 'foot';
  host.replaceChildren();
  if (meta?.sample) {
    const tag = node('span', 'sample-tag', 'Sample data');
    tag.title = 'Every figure on this build comes from lib/mock.js. Nothing here is a '
      + 'measurement until lib/data.js is pointed at the API.';
    host.append(tag);
  }
  const build = node('span');
  build.append(document.createTextNode('Build '), node('code', undefined, meta?.build ?? '—'));
  host.append(build);
  host.append(node('span', 'foot-sep'));
  host.append(node('span', undefined,
    `${Number(meta?.addressesQualifying ?? 0).toLocaleString('en-US')} of `
    + `${Number(meta?.addressesSeen ?? 0).toLocaleString('en-US')} addresses closed a round-trip`));
  host.append(node('span', 'spacer'));
  host.append(node('span', undefined,
    'Realized PnL on closed round-trips only. Nothing here places or copies a trade.'));
}
