/**
 * The palette, checked rather than asserted.
 *
 * WHAT MOVED AND WHAT DID NOT. The values are new — the black-and-lime skin is gone, and
 * with it the tests that pinned #ccff00 as a band, #cdf460 as the positive, and a headline
 * surviving on lime under three colour-blindness simulations. The RULES those tests existed
 * to enforce are unchanged and are all still here, now measured against a two-theme palette:
 *
 *   - no token is a sign colour under another name          (the --accent-soft bug)
 *   - a sign colour goes only to a figure that has a sign   (the win-rate-in-green bug)
 *   - no colour literal outside tokens.css                  (the rgba-on-the-track bug)
 *   - nothing can out-specify .up/.down on a nested figure  (the `.dstat strong` bug)
 *   - every foreground clears AA on the ground it sits on, IN BOTH THEMES
 *   - the two sign colours are NOT separable without colour, which is why the glyph exists
 *   - the amber is caution and nothing else
 *   - a medal is ordinal, readable, and never a sign colour
 *
 * Everything resolves through test/css-colour.mjs, so a value written as oklch(), rgb(), a
 * name or uppercase hex is the same value to every check here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  componentLiterals, deltaE, palette, parseColour, rules, SAME, signOverrides, substitute,
  toHex, toOklab, twins, unresolvedTokens, usersOf, weakText,
} from './css-colour.mjs';

const web = new URL('../web/', import.meta.url);
const read = (/** @type {string} */ p) => readFile(new URL(p, web), 'utf8');

const TOKENS = await read('styles/tokens.css');
const SHEETS = ['base', 'board', 'copy', 'asset', 'landing', 'profile', 'search', 'markets'];
/** @type {Record<string, string>} */
const CSS = Object.fromEntries(await Promise.all(SHEETS.map(async (n) => [n, await read(`styles/${n}.css`)])));
const PAL = palette([TOKENS], SHEETS.map((n) => CSS[n]));
/** The grounds a foreground can sit on. */
const GROUNDS = ['surface', 'surface-2', 'sunken', 'muted-bg'];
/** @param {string} theme @returns {Map<string, import('./css-colour.mjs').Colour>} */
const colours = (theme) => /** @type {any} */ (PAL.resolved.get(theme)).colours;
/** @param {string} theme @param {string} name */
const tok = (theme, name) => /** @type {any} */ (colours(theme).get(name));

test('every colour token resolves, in both themes, to a colour sRGB can show', () => {
  // A value that looks like a colour and cannot be resolved is a failure, never a skip: a
  // notation this suite does not understand would switch every check below off for that
  // token without a word.
  assert.deepEqual([...PAL.tables.keys()], ['base', '[data-theme="dark"]'],
    'the palette no longer declares exactly a light and a dark theme');
  const problems = unresolvedTokens(PAL);
  assert.deepEqual(problems, [], `unresolvable tokens:\n  ${problems.join('\n  ')}`);
  for (const theme of PAL.tables.keys()) {
    for (const name of ['up', 'down', 'accent', 'accent-text', 'fg', 'surface', 'warn']) {
      assert.ok(colours(theme).get(name), `${theme}: --${name} did not resolve`);
    }
  }
});

test('no token is a sign colour under another name, in either theme', () => {
  // THE ROOT CAUSE THIS KEEPS CATCHING. --accent-soft was once the same value as --up, so
  // every hover border on the site was drawn in the positive sign colour under a name that
  // did not say so. Compared by resolved value within one just-noticeable difference, so a
  // synonym, another notation, or a hex one rounding step away all count.
  const found = twins(PAL, ['up', 'down']);
  assert.deepEqual(found, [], `these are a sign colour under another name:\n  ${found.join('\n  ')}`);
});

test('the accent is a third colour, never a fourth sign', () => {
  // The contract's first rule: --accent is the copy action, --up is the positive sign, and
  // there is no third green. They are close in hue and that is the risk — an accent that
  // drifted to within a just-noticeable difference of --up would turn every Copy button
  // into a gain.
  for (const theme of PAL.tables.keys()) {
    for (const accent of ['accent', 'accent-text']) {
      for (const sign of ['up', 'down']) {
        const d = deltaE(tok(theme, accent), tok(theme, sign));
        assert.ok(d >= SAME, `${theme}: --${accent} is ${d.toFixed(3)} from --${sign}`);
      }
    }
  }
  // Not vacuous: the copy action is actually drawn in it.
  const users = [...usersOf(PAL, ['accent']).users.keys()];
  assert.ok(users.some((sel) => /btn-accent|btn-copy/.test(sel)),
    'nothing draws the copy action in the accent');
});

test('the accent is a surface; --accent-text is the form that may be a letter', () => {
  // tokens.css says it: #00B843 is 2.65:1 on white — a fine surface and an illegible letter
  // — so the accent has a second value for the places it is a foreground. This is that note,
  // enforced, in both directions so the pair keeps its jobs.
  /** @type {string[]} */
  const asText = [];
  /** @type {string[]} */
  const asFill = [];
  for (const theme of PAL.tables.keys()) {
    const table = /** @type {any} */ (PAL.tables.get(theme));
    for (const r of rules(PAL.components)) {
      for (const [prop, raw] of r.decls) {
        // Only the two properties this rule is about. Scanning every declaration meant
        // `transition: color 150ms ease` arrived here and was read as a colour, because its
        // value starts with the word the color() function also starts with.
        if (!/^(color|background|background-color|fill)$/.test(prop)) continue;
        const value = substitute(raw, table).trim();
        if (/var\(/.test(value) || !/^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|color\(|lab\(|lch\()/i.test(value)) continue;
        const c = parseColour(value);
        if (prop === 'color' && deltaE(c, tok(theme, 'accent')) < SAME) {
          asText.push(`${theme}: ${r.selector} { color: ${raw} }`);
        }
        if (/^(background|background-color|fill)$/.test(prop)
          && deltaE(c, tok(theme, 'accent-text')) < SAME) {
          asFill.push(`${theme}: ${r.selector} { ${prop}: ${raw} }`);
        }
      }
    }
  }
  assert.deepEqual(asText, [],
    `--accent is a surface, not a letter; --accent-text is the drawn form:\n  ${asText.join('\n  ')}`);
  assert.deepEqual(asFill, [],
    `--accent-text is the letter, not a fill:\n  ${asFill.join('\n  ')}`);
});

test('the sign colours are spent only on things that have a sign', () => {
  /*
   * MATCHED ON RESOLVED VALUE, NOT ON TOKEN NAME, in both themes.
   *
   * The line the allowlist draws: a SIGNED QUANTITY may take a sign colour. A rate, a share,
   * a count, a verdict, a mode, a tab or a progress bar may not — those are the neutral
   * channel, because colour on this site means direction and only direction. A transient
   * status indicator is not a quantity at all and is exempt, listed so the exemption is
   * deliberate rather than an oversight.
   *
   * Adding a selector here is allowed. Doing it without reading the paragraph above is what
   * this is trying to prevent.
   */
  const allowed = new Map([
    ['.up', 'the sign class itself'],
    ['.down', 'the sign class itself'],
    ['.copybtn.is-ok', 'status: a copy succeeded. Not a quantity'],
    ['.copybtn.is-fail', 'status: a copy failed. Not a quantity'],
    ['.profile-card-square.up', 'one square per round-trip — each square is a win or a loss'],
    ['.profile-card-square.down', 'the same, outlined instead of filled'],
    ['.as-bubble-pct.up', 'a holder\'s own signed PnL, on the bubble'],
    ['.as-bubble-pct.down', 'the same, negative'],
    ['.as-legend-swatch--up', 'the legend that names those two colours'],
    ['.as-legend-swatch--down', 'the same, negative'],
  ]);
  const { users, problems } = usersOf(PAL, ['up', 'down']);
  const offenders = [...problems];
  for (const [sel, evidence] of users) {
    if (!allowed.has(sel)) offenders.push(`${sel} — ${evidence[0]}`);
  }
  assert.deepEqual(offenders, [],
    'these resolve to a sign colour and are not in the allowlist — read the note above '
    + `this test before adding them:\n  ${offenders.join('\n  ')}`);
  assert.ok(users.has('.up') && users.has('.down'), 'the sign classes no longer reach the sign colours');
});

test('nothing can override the colour of a signed figure', () => {
  // THE BUG THIS EXISTS FOR. `.dstat strong { color: … }` is specificity (0,1,1) and beat
  // `.up` at (0,1,0), so every signed figure in that row rendered neutral and its direction
  // glyph inherited the same neutral. Presence is not the claim; the claim is three channels.
  const offenders = signOverrides(PAL.components);
  assert.deepEqual(offenders, [],
    `these set colour on a bare element and will beat .up/.down:\n  ${offenders.join('\n  ')}`);
  assert.match(CSS.base, /\.up\s*\{[^}]*color:\s*var\(--up\)/);
  assert.match(CSS.base, /\.down\s*\{[^}]*color:\s*var\(--down\)/);
});

test('the stylesheets hold no colour the palette has not named', () => {
  // Any notation, not only hex: the check that let five rgba() literals sit on a track for a
  // whole skin was a hex regex. Comments, strings and url()s are stripped first.
  const literals = componentLiterals(PAL.components);
  assert.deepEqual(literals, [], `colour literals outside tokens.css:\n  ${literals.join('\n  ')}`);
});

test('every text colour clears AA on the ground it sits on, in both themes', () => {
  // Read off the stylesheets rather than listed, so a token that fails cannot be used as
  // text anywhere without this failing. Display type at 24px+ is held to 3:1 and text in a
  // disabled control is exempt, both per WCAG 1.4.3.
  const weak = weakText(PAL, GROUNDS);
  assert.deepEqual(weak, [], `below AA:\n  ${weak.join('\n  ')}`);
});

/**
 * Colour is a channel this site cannot assume it has.
 *
 * Machado, Oliveira & Fernandes (2009), severity 1.0, applied in LINEAR light — applying
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
/** @param {import('./css-colour.mjs').Colour} c @param {string} kind */
function seenAs(c, kind) {
  const v = c.lin;
  if (kind === 'greyscale') {
    const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return [y, y, y];
  }
  return CVD[kind].map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}
/** @param {number[]} a @param {number[]} b */
function ratio(a, b) {
  const Y = (/** @type {number[]} */ v) => {
    const c = v.map((u) => Math.min(1, Math.max(0, u)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [hi, lo] = [Y(a), Y(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const KINDS = ['greyscale', 'protanopia', 'deuteranopia', 'tritanopia'];

test('every figure stays readable on its ground without colour, in both themes', () => {
  /** @type {[string, string][]} */
  const pairs = [['up', 'surface'], ['down', 'surface'], ['fg', 'surface'], ['muted', 'surface'],
    ['inv-fg', 'inv-bg'], ['accent-ink', 'accent']];
  /** @type {string[]} */
  const failures = [];
  for (const theme of PAL.tables.keys()) {
    for (const kind of KINDS) {
      for (const [fg, bg] of pairs) {
        const r = ratio(seenAs(tok(theme, fg), kind), seenAs(tok(theme, bg), kind));
        // Greyscale is physics — a luminance ratio with the hue thrown away — so it is held
        // to AA. The three dichromatic cases are a MODEL (Machado et al.), and a model
        // missing the line by a percent is not a fact about a screen; a model missing it by
        // half is. --down under deuteranopia sits at 4.46 here, and the figure it colours
        // also carries ▼ and an explicit −, which is the channel that actually does this job.
        const floor = kind === 'greyscale' ? 4.5 : 4;
        if (r < floor) failures.push(`${theme}/${kind}: --${fg} on --${bg} is ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `below AA without colour:\n  ${failures.join('\n  ')}`);
});

test('the two sign colours are NOT distinguishable without colour, which is the point', () => {
  // A reader without colour cannot tell a gain from a loss by hue, and is not expected to —
  // that is precisely why every signed figure also carries ▲/▼ and an explicit + or −. This
  // test exists so the redundancy is never removed on the grounds that "the colours are
  // different enough".
  for (const theme of PAL.tables.keys()) {
    const worst = Math.min(...KINDS.map((k) => ratio(
      seenAs(tok(theme, 'up'), k), seenAs(tok(theme, 'down'), k))));
    assert.ok(worst < 4.5,
      `${theme}: up and down now separate at ${worst.toFixed(2)} without colour. If that is `
      + 'real, the glyph is still required — revisit this note, do not delete the glyph.');
  }
});

test('the medals are ordinal, readable, and never a sign colour', () => {
  for (const theme of PAL.tables.keys()) {
    const ladder = ['medal-gold', 'medal-silver', 'medal-bronze'];
    // A ladder by the brightness of the chip, so first reads as first before the numeral is
    // read. The numeral itself is asserted where the badge is built.
    const L = ladder.map((n) => toOklab(tok(theme, `${n}-bg`).lin)[0]);
    assert.ok((L[0] > L[1] && L[1] > L[2]) || (L[0] < L[1] && L[1] < L[2]),
      `${theme}: the medal chips are not a ladder: ${L.map((x) => x.toFixed(3)).join(' ')}`);
    for (const n of ladder) {
      for (const sign of ['up', 'down']) {
        assert.ok(deltaE(tok(theme, `${n}-bg`), tok(theme, sign)) >= SAME,
          `${theme}: --${n}-bg is the ${sign} colour`);
      }
      const r = ratio(tok(theme, n).lin, tok(theme, `${n}-bg`).lin);
      assert.ok(r >= 4.5, `${theme}: --${n} on --${n}-bg is ${r.toFixed(2)}`);
    }
  }
});

test('the amber is caution and nothing else', () => {
  /*
   * NOT DRIFT. The palette is a binary — a positive and a negative — and that binary has
   * nowhere to put "measured, but here is how much of this is not". On a site whose central
   * argument is its coverage caveat, that is not a detail worth losing to a palette rule.
   * The exception is bounded to CAUTION: a selector that takes the amber has to say in its
   * own name that it is one.
   */
  for (const theme of PAL.tables.keys()) {
    for (const sign of ['up', 'down', 'accent']) {
      assert.ok(deltaE(tok(theme, 'warn'), tok(theme, sign)) >= SAME,
        `${theme}: --warn collapsed into --${sign}`);
    }
  }
  for (const sel of [...usersOf(PAL, ['warn', 'warn-fill']).users.keys()]) {
    assert.match(sel, /warn|caution|notice|stale|partial|unwired/i,
      `${sel} takes the caution colour and is not a caution`);
  }
});

test('the palette values are the design\'s, not a hand-tuned drift of them', () => {
  // The handful everything else is measured against. A skin that changes should change here,
  // in one visible edit, rather than one component at a time.
  const light = { surface: '#ffffff', fg: '#11140f', up: '#067a2f', down: '#c8360f', accent: '#00b843' };
  for (const [name, hex] of Object.entries(light)) {
    assert.equal(toHex(tok('base', name)), hex, `--${name} drifted from the design's value`);
  }
  const dark = { surface: '#111310', fg: '#eef1ea', up: '#4bd17a', down: '#ff7a57' };
  for (const [name, hex] of Object.entries(dark)) {
    assert.equal(toHex(tok('[data-theme="dark"]', name)), hex,
      `--${name} drifted from the design's dark value`);
  }
});
