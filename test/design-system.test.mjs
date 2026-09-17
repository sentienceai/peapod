/**
 * The tokens are the spec's, checked against the spec.
 *
 * "Apply it precisely, matching the measured values rather than approximating them" is a
 * claim about numbers, so it is checkable: this reads the front matter of
 * design-refs/robinhood-DESIGN.md and asserts the shipped stylesheet carries those exact
 * values. A scale that drifts toward the rounder numbers a hand reaches for — 8/16/32,
 * 200ms, 1200px — fails here rather than being noticed by nobody.
 *
 * Where the spec is silent the test says so explicitly, because the silences are where the
 * judgement went: it measures three type sizes and this page needs seven, and it never
 * mentions tabular figures because robinhood.com is prose and this is columns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const spec = await readFile(new URL('../design-refs/robinhood-DESIGN.md', import.meta.url), 'utf8');
const tokens = await readFile(new URL('../web/styles/tokens.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../web/styles/app.css', import.meta.url), 'utf8');
const front = spec.slice(0, spec.indexOf('\n---', 4));

/** @param {string} name */
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens);
  return m ? m[1].trim() : null;
};
/** @param {string} key */
const specValue = (key) => {
  const m = new RegExp(`${key}:\\s*"?([^"\\n]+)"?`).exec(front);
  return m ? m[1].trim() : null;
};

test('the spacing scale is the spec\'s, and it is not a doubling series', () => {
  const m = /scale:\s*(\[[^\]]+\])/.exec(front);
  assert.ok(m, 'the spec no longer declares a spacing scale');
  const scale = JSON.parse(m[1]);
  assert.deepEqual(scale, [8, 12, 16, 24, 32, 36, 48, 52, 60, 128],
    'the spec file changed; re-read it before trusting anything below');
  assert.equal(token('s-base'), specValue('base'), 'the 4px base is not the spec\'s');
  const shipped = scale.map((_, i) => token(`s-${i + 1}`));
  assert.deepEqual(shipped, scale.map((n) => `${n}px`),
    'the spacing steps drifted from the measured scale');
  // The point of the scale: it clusters for density then jumps. A doubling series would
  // have passed the check above only by accident, so the shape is asserted too.
  assert.ok(scale[scale.length - 1] / scale[scale.length - 2] > 2,
    'the scale no longer makes a dramatic jump for section breaks');
});

test('the type scale carries the measured sizes and their measured tracking', () => {
  /** @type {[string, string, string, string][]} */
  const measured = [
    ['display', '72px', '-1px', '1.08'],
    ['head', '40px', '-1px', '1.2'],
    ['body', '16px', '-0.25px', '1.5'],
  ];
  for (const [name, size, tracking, leading] of measured) {
    assert.equal(token(`t-${name}`), size, `--t-${name}`);
    assert.equal(token(`ls-${name}`), tracking, `--ls-${name} — tracking is measured in px`);
    assert.equal(token(`lh-${name}`), leading, `--lh-${name}`);
  }
  // The spec measures three sizes. A table needs labels and column headers as well, and
  // those steps are ours; they must exist and must not invent tighter tracking than the
  // smallest measured value, because below 16px tighter is less legible.
  for (const name of ['lead', 'num', 'small', 'micro']) {
    assert.ok(token(`t-${name}`), `--t-${name} is missing`);
    const ls = Number((token(`ls-${name}`) ?? '0').replace('px', ''));
    assert.ok(ls >= -1 && ls <= 0, `--ls-${name} is ${ls}px, outside the measured range`);
  }
});

test('one weight, as the spec requires', () => {
  // "Font weight 400 across all scales... hierarchy relies entirely on size, color, and
  // positioning." The three weight names are kept so nothing downstream has to change,
  // but they all have to resolve to 400 or the page is using a tool the spec removed.
  for (const w of ['w-regular', 'w-medium', 'w-semi']) {
    assert.equal(token(w), '400', `--${w} reintroduces weight as emphasis`);
  }
});

test('the 36px radius is on what the spec puts it on', () => {
  assert.equal(token('r-pill'), '36px', 'the spec\'s only measured radius');
  // "Rounded corners on interactive elements only, keeping cards and data containers more
  // rectangular." The product's own cards measure 6.5px, so a card at 36px would be
  // applying the number while contradicting the sentence that comes with it.
  assert.equal(token('r-card'), '6px');
  const pillRules = [...app.matchAll(/([^{}]+)\{([^{}]*border-radius:\s*var\(--r-pill\)[^{}]*)\}/g)]
    .map((m) => m[1].trim());
  assert.ok(pillRules.length >= 3, 'almost nothing takes the pill radius');
  for (const sel of pillRules) {
    assert.ok(/button|pill|tab|toggle|keycap|chip|search|badge|\.wallet|input|select/i.test(sel),
      `${sel} is not an interactive element but takes the pill radius`);
  }
});

test('motion is one duration and one easing', () => {
  assert.equal(token('motion'), '300ms');
  assert.equal(token('ease'), 'ease');
  const literals = [...app.matchAll(/transition:[^;]*?(\d+)ms/g)].map((m) => m[1]);
  assert.deepEqual(literals, [],
    `transitions with their own duration: ${literals.join(', ')} — the spec has one`);
});

test('every breakpoint the stylesheet uses is one of the seven measured', () => {
  const bp = /breakpoints:\s*(\[[^\]]+\])/.exec(front);
  assert.ok(bp, 'the spec no longer declares breakpoints');
  const seven = JSON.parse(bp[1].replace(/(\d+)px/g, '"$1px"'));
  assert.deepEqual(seven, ['426px', '485px', '768px', '1024px', '1049px', '1280px', '1441px']);
  const used = [...new Set([...app.matchAll(/\((?:max|min)-width:\s*(\d+px)\)/g)].map((m) => m[1]))];
  const strays = used.filter((w) => !seven.includes(w));
  assert.deepEqual(strays, [],
    `breakpoints that are not in the measured set: ${strays.join(', ')}`);
  assert.ok(used.length >= 3, 'the layout no longer responds at any measured breakpoint');
});

test('figures are tabular, which the spec does not cover and this page needs', () => {
  // robinhood.com is prose; this is a money column. Proportional digits put $1,111.11 and
  // $8,888.88 on different widths, so two rows cannot be compared without reading them.
  assert.match(app, /font-variant-numeric:\s*tabular-nums/,
    'the numeric columns lost their tabular figures');
  assert.match(app, /'tnum' 1/, 'the feature flag fallback went with it');
});

test('the substitute faces are named, loaded, and have a real fallback', async () => {
  // Martina Plantijn and Phonic are licensed and we cannot ship them. The stack has to
  // degrade to something with the same proportions rather than to a default.
  assert.match(token('display') ?? '', /Newsreader/, 'the display substitute is missing');
  assert.match(token('display') ?? '', /serif$/, 'the display stack has no generic fallback');
  assert.match(token('sans') ?? '', /Inter/, 'the body substitute is missing');
  // The spec's own fallback names Helvetica first — Robinhood's read on what Phonic is
  // nearest to — so it stays in the stack under our substitute.
  assert.match(token('sans') ?? '', /Helvetica/, 'the spec\'s own fallback was dropped');
  for (const page of ['../web/index.html', '../web/traders.html']) {
    const html = await readFile(new URL(page, import.meta.url), 'utf8');
    assert.match(html, /fonts\.googleapis\.com[^"]*Newsreader/, `${page} does not load the display face`);
    assert.match(html, /fonts\.googleapis\.com[^"]*Inter/, `${page} does not load the body face`);
  }
});
