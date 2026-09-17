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
const app = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
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

test('the spec\'s own tokens are all present, each doing one job', () => {
  // The four colours the design system names, and the values measured off the product
  // screenshot for the roles it does not carry. A derived value is only defensible while
  // its source is still on the page.
  const spec = { '#ccff00': 'brand', '#110e08': 'brand-ink', '#000000': 'bg', '#ffffff': 'text' };
  for (const [hex, name] of Object.entries(spec)) {
    assert.equal(T[name], hex, `--${name} is no longer the ${hex} the spec measures`);
  }
  const measured = { '#cdf460': 'up', '#ec6688': 'down', '#949fa5': 'text-muted',
    '#1f2124': 'line', '#31363a': 'line-soft' };
  for (const [hex, name] of Object.entries(measured)) {
    assert.equal(T[name], hex, `--${name} drifted from the ${hex} measured off the product`);
  }
  // The divider inside a table is LIGHTER than the border around a card. One grey for
  // both is what made a table read as a single block.
  assert.ok(luminance(T['line-soft']) > luminance(T.line),
    'the row divider is no longer lighter than the card border');
});

test('every foreground the interface renders clears WCAG AA on its ground', () => {
  /** @type {[string, string][]} */
  const pairs = [
    ['text', 'bg'], ['text-body', 'bg'], ['text-muted', 'bg'], ['up', 'bg'], ['down', 'bg'],
    // The one lift on the page, carrying the smallest labels.
    ['text-muted', 'raised'], ['text-body', 'raised'],
    // Figures sit on their own chart fills.
    ['up', 'up-fill'], ['down', 'down-fill'],
    // The brand band has exactly one ink, and the muted step inside it.
    ['brand-ink', 'brand'], ['brand-ink-soft', 'brand'],
    // The label grey also sits against the row divider it runs beside.
    ['text-muted', 'line-soft'],
    ['focus', 'bg'], ['rank-3', 'bg'],
  ];
  /** @type {string[]} */
  const failures = [];
  for (const [fg, bg] of pairs) {
    const r = contrast(T[fg], T[bg]);
    if (r < 4.5) failures.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
  }
  assert.deepEqual(failures, [], `below AA:\n  ${failures.join('\n  ')}`);
});

test('no signed figure is ever rendered on the brand surface', () => {
  // THE WHOLE LIME QUESTION, AS AN ASSERTION. The spec lists #ccff00 as `background`, and
  // on a marketing page it is one. Behind this table both sign colours die at once:
  //   up on lime 1.07, down on lime 2.62, and white on lime 1.21.
  // So the resolution is not "pick the readable sign colour", it is that the lime surface
  // carries no signed figure at all. These numbers are the reason, kept here so that a
  // later attempt to put a number in the band fails with the arithmetic attached.
  for (const sign of ['up', 'down', 'text']) {
    assert.ok(contrast(T[sign], T.brand) < 3,
      `--${sign} now reads on the lime; if that is real, revisit the rule rather than the test`);
  }
  // The one ink the band can use, and it clears AAA.
  assert.ok(contrast(T['brand-ink'], T.brand) > 7,
    `the band's only usable ink fell to ${contrast(T['brand-ink'], T.brand).toFixed(2)}`);
  // And the band must hold nothing but the headline. .page-head sets the brand background;
  // anything else in it would be styled here.
  assert.match(app, /\.page-head \{[^}]*background: var\(--brand\)/,
    'the brand band is no longer the page head');
});

test('the podium medals are ordinal, distinguishable, and never the sign colour', () => {
  const ladder = [T['rank-1'], T['rank-2'], T['rank-3']];
  assert.ok(ladder.every(Boolean), 'the medals are not defined');
  // Separated by BRIGHTNESS, not hue. The spec has no neutral secondary palette and forces
  // a binary, so three hues would be three inventions; a ladder is inside the system.
  const L = ladder.map(luminance);
  assert.ok(L[0] > L[1] && L[1] > L[2], `the medals are not ordered: ${ladder.join(' ')}`);
  for (const [a, b] of [[0, 1], [1, 2]]) {
    const r = (L[a] + 0.05) / (L[b] + 0.05);
    assert.ok(r > 1.4, `ranks ${a + 1} and ${b + 2 - 1} are ${r.toFixed(2)} apart — not seen, read`);
  }
  // Never lime: rank one is the obvious place for the brand colour and the worst place
  // for it, because the card it badges already carries a lime figure.
  for (const m of ladder) {
    assert.notEqual(m.toLowerCase(), T.brand.toLowerCase(), 'a medal is the sign colour');
    assert.notEqual(m.toLowerCase(), T.up.toLowerCase(), 'a medal is the sign colour');
  }
  for (const m of ladder) {
    for (const ground of ['bg', 'raised']) {
      const r = contrast(m, T[ground]);
      assert.ok(r >= 4.5, `${m} on --${ground} is ${r.toFixed(2)}`);
    }
  }
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
  // Comments stripped first: the measured values are written down beside the rules that
  // use them, and a hex in a comment is documentation, not a colour on the page.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  // One exception, and it is a shade of black used as a scrim, not a palette colour.
  const unexpected = literals.filter((h) => h.toLowerCase() !== '#000000cc');
  assert.deepEqual(unexpected, [],
    `hardcoded colours in app.css: ${unexpected.join(', ')}`);
});

test('nothing can override the colour of a signed figure', async () => {
  // THE BUG THIS EXISTS FOR. `.dstat strong { color: … }` is specificity (0,1,1) and beat
  // `.up` at (0,1,0), so every signed figure in that row rendered neutral and its
  // direction glyph inherited the same neutral. The sign test passed throughout, because
  // it checked that the glyph was PRESENT and that its character was right — never that
  // it carried a sign colour. Presence is not the claim; the claim is three channels.
  const app = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
  const stripped = app.replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * @param {string} sel
   * :where() contributes nothing, which is the tool for saying "style this, but never
   * at the cost of a colour a class is asserting".
   */
  const specificity = (sel) => {
    const outside = sel.replace(/:where\([^)]*\)/g, ' ');
    const ids = (outside.match(/#[\w-]+/g) || []).length;
    const classes = (outside.match(/[.[][\w-]+|:[a-z-]+(\([^)]*\))?/g) || []).length;
    return ids * 100 + classes * 10;
  };

  /** @type {string[]} */
  const offenders = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    if (!/(^|;)\s*color\s*:/.test(body)) continue;
    for (const one of m[1].split(',').map((x) => x.trim())) {
      if (!one || one.startsWith('@')) continue;
      const last = one.split(/\s+|>/).filter(Boolean).pop() ?? '';
      // A signed figure is a <strong> or <span> carrying .up/.down, holding a
      // <span class="mark">. A rule whose final compound is one of those bare elements,
      // at a specificity above a single class, wins over the sign colour.
      if (/^(strong|span|b|i)$/.test(last) && specificity(one) >= 10) offenders.push(one);
    }
  }
  assert.deepEqual(offenders, [],
    `these set colour on a bare element and will beat .up/.down:\n  ${offenders.join('\n  ')}`);

  // And the sign colours themselves are declared at exactly one class of specificity,
  // so the rule above is the whole guard.
  assert.match(stripped, /(^|\n)\.up \{ color: var\(--up\); \}/);
  assert.match(stripped, /(^|\n)\.down \{ color: var\(--down\); \}/);
});
