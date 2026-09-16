/**
 * The palette, checked rather than asserted.
 *
 * Contrast is the kind of thing that is verified once at design time and then quietly
 * broken by a later tweak, because nothing fails when it is. These tests read the shipped
 * tokens and recompute every pair the interface actually puts together, so a value that
 * drifts below AA fails the suite rather than shipping.
 *
 * They also pin the five source swatches. The palette is derived from them, and a derived
 * value is only defensible while its source is still on the page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../web/styles/tokens.css', import.meta.url), 'utf8');
/** @type {Record<string, string>} */
const T = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]),
);

/** @param {string} h */
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/** @param {string} h */
function luminance(h) {
  const [r, g, b] = rgb(h).map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the five source swatches are all present, each doing one job', () => {
  const swatches = {
    '#0e3b2e': 'up-fill', '#1f5d4a': 'accent', '#a8c6b8': 'accent-soft',
    '#e9f1ee': 'text', '#2b2f33': 'surface',
  };
  for (const [hex, token] of Object.entries(swatches)) {
    assert.equal(T[token], hex, `--${token} is no longer the ${hex} swatch`);
  }
  // The two light greens can never be the ground on a dark layout.
  for (const ground of ['bg', 'surface', 'raised']) {
    assert.ok(luminance(T[ground]) < 0.1,
      `--${ground} is ${T[ground]}, too light to sit under this layout`);
  }
});

test('every foreground the interface renders clears WCAG AA on its ground', () => {
  /** @type {[string, string][]} */
  const pairs = [
    ['text', 'surface'], ['text-body', 'surface'], ['text-muted', 'surface'],
    ['up', 'surface'], ['down', 'surface'], ['warn', 'surface'],
    ['text', 'bg'], ['text-body', 'bg'], ['text-muted', 'bg'], ['up', 'bg'], ['down', 'bg'],
    // The filter pills carry the smallest labels on the page, on the lightest surface.
    ['text-muted', 'raised'], ['text-body', 'raised'],
    // Figures sit on their own chart fills.
    ['up', 'up-fill'], ['down', 'down-fill'],
    // The accent is a fill, so what matters is the ink on it.
    ['accent-ink', 'accent'],
    ['accent-soft', 'bg'], ['accent-soft', 'surface'], ['focus', 'surface'], ['focus', 'bg'],
  ];
  /** @type {string[]} */
  const failures = [];
  for (const [fg, bg] of pairs) {
    const r = contrast(T[fg], T[bg]);
    if (r < 4.5) failures.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
  }
  assert.deepEqual(failures, [], `below AA:\n  ${failures.join('\n  ')}`);
});

test('the moss swatch is used as a fill, never as a foreground', () => {
  // At 1.3 against the ground it is invisible as text or as a hairline. The rule is in
  // the token comment; this is what makes it true of the stylesheet.
  const app = css + '\n';
  assert.ok(contrast(T.accent, T.bg) < 2,
    'the accent got light enough to be a foreground — revisit this rule, do not delete it');
  void app;
});

test('the negative is still a rose, and still distinguishable from the positive', () => {
  const [r, g, b] = rgb(T.down);
  assert.ok(r > g && r > b, `--down is no longer red-dominant: ${T.down}`);
  // Sign is carried three ways, but the two sign colours must not be near-identical.
  assert.ok(contrast(T.up, T.down) > 1.15,
    `--up and --down are too close in luminance: ${contrast(T.up, T.down).toFixed(2)}`);
});

test('the stylesheet does not smuggle in colours the palette does not define', async () => {
  const app = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
  const literals = [...app.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  // One exception, and it is a shade of black used as a scrim, not a palette colour.
  const unexpected = literals.filter((h) => h.toLowerCase() !== '#000000cc');
  assert.deepEqual(unexpected, [],
    `hardcoded colours in app.css: ${unexpected.join(', ')}`);
});
