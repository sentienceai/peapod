/**
 * Day and night, and the one control that switches them.
 *
 * THE CHOICE IS THE READER'S AND IT IS REMEMBERED. The system preference seeds the first
 * visit and nothing after it: someone who opens the dark page at noon has said what they
 * want, and a media query that overrides them on the next load is a bug they cannot report.
 *
 * THE ATTRIBUTE GOES ON <html>. The tokens scope dark to [data-theme='dark'], and a dialog
 * appended to the end of <body> has to inherit the same tokens as the page that opened it.
 * The document element is the only place that is true for every node, including ones that do
 * not exist yet.
 *
 * It is applied before first paint by the snippet each page inlines in <head> (HEAD_SNIPPET
 * below, kept here so the two cannot drift); this module owns every change after that.
 */

const KEY = 'peapod-theme';
const LIGHT = 'light';
const DARK = 'dark';

function stored() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === LIGHT || v === DARK ? v : null;
  } catch {
    // Private windows, blocked storage, embedded frames. Not an error: the page still has a
    // theme, it just does not carry across a reload.
    return null;
  }
}

/** The theme the document is showing right now. */
export function current() {
  return document.documentElement.getAttribute('data-theme') === DARK ? DARK : LIGHT;
}

/** @param {string} theme */
export function apply(theme) {
  const next = theme === DARK ? DARK : LIGHT;
  document.documentElement.setAttribute('data-theme', next);
  try { globalThis.localStorage?.setItem(KEY, next); } catch { /* see stored() */ }
  // Same-tab listeners: a page with two mounted switches — the bar and one inside an open
  // dialog — needs this, because `storage` only fires in OTHER tabs.
  try {
    globalThis.dispatchEvent?.(new CustomEvent('peapod:theme', { detail: next }));
  } catch { /* no event target: nothing is listening either */ }
  return next;
}

/** stored → system → light. */
export function initial() {
  return stored() ?? (globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? DARK : LIGHT);
}

export function toggle() {
  return apply(current() === DARK ? LIGHT : DARK);
}

const SUN = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" '
  + 'style="fill: currentColor; stroke: currentColor;">'
  + '<circle cx="12" cy="12" r="4.5" stroke="none"></circle>'
  + '<path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7'
  + 'M5.3 18.7L7 17M17 7l1.7-1.7" fill="none" stroke-width="2.2" stroke-linecap="round"></path></svg>';
const MOON = '<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" style="fill: currentColor;">'
  + '<path d="M20.6 14.3A8.6 8.6 0 1 1 9.7 3.4a7 7 0 0 0 10.9 10.9z"></path></svg>';

/**
 * The switch: a track with two slots, sun and moon, the active one lit.
 *
 * A switch rather than a button because it names both destinations — a lone moon glyph tells
 * you what you would get but never which one you are in.
 * @param {HTMLElement | null} host
 */
export function mountTheme(host) {
  if (!host) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';

  const sun = document.createElement('span');
  sun.className = 'theme-slot theme-slot--sun';
  sun.innerHTML = SUN;
  const moon = document.createElement('span');
  moon.className = 'theme-slot theme-slot--moon';
  moon.innerHTML = MOON;
  btn.append(sun, moon);

  const paint = () => {
    const dark = current() === DARK;
    // aria-pressed would say "on" or "off" about something that is neither. A label naming
    // the destination is what a screen reader can act on.
    const label = dark ? 'Switch to day mode' : 'Switch to night mode';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    sun.classList.toggle('is-on', !dark);
    moon.classList.toggle('is-on', dark);
  };

  btn.onclick = () => { toggle(); paint(); };
  globalThis.addEventListener?.('peapod:theme', paint);
  globalThis.addEventListener?.('storage', (/** @type {any} */ e) => {
    if (e.key !== KEY || !e.newValue) return;
    document.documentElement.setAttribute('data-theme', e.newValue === DARK ? DARK : LIGHT);
    paint();
  });

  paint();
  host.replaceChildren(btn);
  return btn;
}

/** The snippet each page inlines in <head> so the first paint is already the right theme. */
export const HEAD_SNIPPET = `(function(){try{var v=localStorage.getItem('${KEY}');`
  + `if(v!=='${LIGHT}'&&v!=='${DARK}')v=matchMedia('(prefers-color-scheme: dark)').matches`
  + `?'${DARK}':'${LIGHT}';document.documentElement.setAttribute('data-theme',v);}catch(e){}})()`;
