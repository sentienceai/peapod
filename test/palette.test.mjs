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
  // No exceptions any more. The scrim was the one, and an allowed exception is a place
  // where the next one goes unnoticed — it is --scrim in tokens.css now.
  assert.deepEqual(literals, [],
    `hardcoded colours in app.css: ${literals.join(', ')}`);
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

/**
 * Colour is a channel this page cannot assume it has.
 *
 * Asked whether the lime band survives a greyscale screenshot: it does, and the reason is
 * structural rather than lucky. WCAG contrast is a ratio of RELATIVE LUMINANCE, which is
 * already an achromatic measure — so a pairing that clears it clears it with the colour
 * thrown away. The lime sits at Y 0.84 and the ink at Y 0.006, a 140-fold gap that no hue
 * transform can close. What the simulation below adds is the dichromatic cases, where
 * luminance does move.
 *
 * Machado, Oliveira & Fernandes (2009), severity 1.0, applied in LINEAR light. Applying
 * these matrices to gamma-encoded values is the usual way to get a flattering wrong answer.
 */
/** @type {Record<string, number[][]>} */
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900]],
};
/** @param {string} h */
const linear = (h) => rgb(h).map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
/** @param {number[]} v */
const relLum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
/** @param {string} hex @param {string} kind */
function seenAs(hex, kind) {
  const v = linear(hex);
  if (kind === 'greyscale') return [relLum(v), relLum(v), relLum(v)];
  return CVD[kind].map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}
/** @param {number[]} a @param {number[]} b */
function ratio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the headline on the lime band survives with no colour at all', () => {
  /** @type {string[]} */
  const failures = [];
  for (const kind of ['greyscale', 'protanopia', 'deuteranopia', 'tritanopia']) {
    const r = ratio(seenAs(T['brand-ink'], kind), seenAs(T.brand, kind));
    // AAA, not AA: this is 72px display type and the band is the page's first impression.
    if (r < 7) failures.push(`${kind}: ${r.toFixed(2)}`);
    // And the band must still read as a band — a surface interrupting a black page —
    // or the headline is legible inside something nobody can see the edges of.
    const band = ratio(seenAs(T.brand, kind), seenAs(T.bg, kind));
    if (band < 7) failures.push(`${kind}: the band itself is ${band.toFixed(2)} on the ground`);
  }
  assert.deepEqual(failures, [], `the band loses its legibility without colour:\n  ${failures.join('\n  ')}`);
});

test('every figure stays readable on its ground without colour', () => {
  /** @type {[string, string][]} */
  const pairs = [['up', 'bg'], ['down', 'bg'], ['text', 'bg'], ['text-muted', 'bg'],
    ['brand-ink-soft', 'brand'], ['rank-3', 'bg']];
  /** @type {string[]} */
  const failures = [];
  for (const kind of ['greyscale', 'protanopia', 'deuteranopia', 'tritanopia']) {
    for (const [fg, bg] of pairs) {
      const r = ratio(seenAs(T[fg], kind), seenAs(T[bg], kind));
      if (r < 4.5) failures.push(`${kind}: --${fg} on --${bg} is ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, [], `below AA without colour:\n  ${failures.join('\n  ')}`);
});

test('the two sign colours are NOT distinguishable without colour, which is the point', () => {
  // Measured: up against down falls to 2.15 under deuteranopia and 2.45 in greyscale, and
  // in greyscale the positive renders #e5e5e5 against plain white text at #ffffff. So a
  // reader without colour cannot tell a gain from a loss by colour, and is not expected
  // to — that is precisely why every signed figure also carries ▲/▼ and an explicit + or
  // −, asserted in leaderboard.test.mjs. This test exists so that the redundancy is never
  // removed on the grounds that "the colours are different enough".
  const worst = Math.min(...['greyscale', 'protanopia', 'deuteranopia', 'tritanopia']
    .map((k) => ratio(seenAs(T.up, k), seenAs(T.down, k))));
  assert.ok(worst < 4.5,
    `up and down now separate at ${worst.toFixed(2)} without colour. If that is real, the `
    + 'glyph is still required — revisit this note, do not delete the glyph.');
});

test('no other token carries a sign colour\'s value', () => {
  /*
   * THE ROOT CAUSE, not the symptom. --accent-soft was #cdf460 — the same value as --up —
   * so every hover border, active underline, keycap and inline link on the site was the
   * positive sign colour under a name that did not say so. The allowlist below existed
   * precisely to catch that and could not: it matched on the token NAME, and this was a
   * second name for the same colour.
   *
   * Two names for one colour is the thing to forbid. A page cannot spend a hue on one
   * meaning while a synonym spends it on another.
   */
  const signs = new Set([T.up.toLowerCase(), T.down.toLowerCase()]);
  const twins = Object.entries(T)
    .filter(([name, hex]) => name !== 'up' && name !== 'down' && signs.has(hex.toLowerCase()))
    .map(([name, hex]) => `--${name} is ${hex}`);
  assert.deepEqual(twins, [],
    `these are a sign colour under another name:\n  ${twins.join('\n  ')}`);
});

test('the sign colours are spent only on things that have a sign', () => {
  /*
   * MATCHED ON RESOLVED VALUE, NOT ON TOKEN NAME. The first version of this read the
   * stylesheet for the literal strings var(--up) and var(--down), which is a check that
   * only works while nobody has introduced a synonym — and somebody had. Every declaration
   * is now resolved through the token table first, so an alias, a raw hex, or a value
   * reached through two hops of var() all arrive at the same place.
   *
   * The line the allowlist draws: a SIGNED QUANTITY may take a sign colour. A rate, a
   * share, a verdict or an ordinal may not — those use the neutral ladder. A transient
   * status indicator is not a quantity at all and is exempt, listed so the exemption is
   * deliberate rather than an oversight.
   *
   * Adding a selector here is allowed. Doing it without reading the paragraph above is
   * what this is trying to prevent.
   */
  const allowed = new Map([
    ['.up', 'the sign class itself'],
    ['.down', 'the sign class itself'],
    ['.streak i', 'one square per round-trip — each square is a win or a loss'],
    ['.streak i.loss', 'the same, outlined instead of filled'],
    ['.copy.is-ok', 'status: a copy succeeded. Not a quantity'],
    ['.copy.is-fail', 'status: a copy failed. Not a quantity'],
    ['.wallet-note.is-fail', 'status: a wallet refused. Not a quantity'],
    ['.status-dot', 'status: a build is being served. Not a quantity'],
  ]);

  /**
   * Resolve var() chains against the token table, so --alias and #cdf460 and
   * var(--up) all come out as the same string.
   * @param {string} value
   */
  const resolve = (value) => {
    let out = value;
    for (let hop = 0; hop < 6 && out.includes('var(--'); hop += 1) {
      out = out.replace(/var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)/g,
        (whole, name) => T[name] ?? whole);
    }
    return out.toLowerCase();
  };
  const signs = [T.up.toLowerCase(), T.down.toLowerCase()];

  const stripped = app.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {string[]} */
  const offenders = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = resolve(m[2]);
    if (!signs.some((hex) => body.includes(hex))) continue;
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      if (!sel || sel.startsWith('@') || allowed.has(sel)) continue;
      offenders.push(`${sel} { ${m[2].trim()} }`);
    }
  }
  assert.deepEqual(offenders, [],
    'these resolve to a sign colour and are not in the allowlist — read the note above '
    + `this test before adding them:\n  ${offenders.join('\n  ')}`);

  // Not vacuous, and specifically not vacuous through the resolver: the sign classes must
  // still be here, and resolving them must still reach the sign colours.
  assert.match(stripped, /\.up \{ color: var\(--up\); \}/);
  assert.match(stripped, /\.down \{ color: var\(--down\); \}/);
  assert.equal(resolve('var(--up)'), signs[0]);
  assert.equal(resolve('var(--down)'), signs[1]);
});

test('the amber is the one colour outside the spec, and it is deliberate', () => {
  /*
   * NOT DRIFT. Robinhood's system is binary by design — lime or dark, no neutral secondary
   * palette — and that binary has nowhere to put "measured, but here is how much of this
   * is not". On a site whose central argument is its coverage caveat, that is not a detail
   * worth losing to a palette rule.
   *
   * The exception is bounded to CAUTION, and the list below is what bounds it. I described
   * it as one meter when I added the note and this test found two more the same day — all
   * three saying the same kind of thing, which is the test doing its job rather than the
   * claim being wrong by much:
   *
   *   .bar i.warn            how much of an address's flow has no round-trip behind it
   *   .warn-note             the caveat's line about RWA's profit rate being small in size
   *   .status-dot.is-empty   no build is being served yet
   *
   * Each is paired with words carrying the same message, so colour is never the only
   * channel. Anything else that reaches for the amber is drift and fails here.
   */
  assert.ok(T.warn, '--warn is gone; if the amber was removed, remove this test with it');
  for (const sign of ['up', 'down', 'brand']) {
    assert.notEqual(T.warn.toLowerCase(), T[sign].toLowerCase(),
      `--warn collapsed into --${sign}`);
  }
  assert.ok(contrast(T.warn, T.bg) >= 4.5,
    `--warn on the ground is ${contrast(T.warn, T.bg).toFixed(2)}`);

  const stripped = app.replace(/\/\*[\s\S]*?\*\//g, '');
  const users = [...stripped.matchAll(/([^{}]+)\{([^{}]*var\(--warn\)[^{}]*)\}/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim()));
  assert.deepEqual(users.sort(), ['.bar i.warn', '.status-dot.is-empty', '.warn-note'],
    `the amber spread beyond caution: ${users.join(', ')}`);
});
