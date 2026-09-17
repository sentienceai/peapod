/**
 * The build contract, checked against the shipped files.
 *
 * WHAT THIS FILE REPLACES. It used to pin the Robinhood spec the earlier skin was measured
 * from: a 10-step spacing scale, 72/40/16 type with per-size tracking, weight 400
 * everywhere, a 36px pill, 300ms motion, seven breakpoints, Newsreader and Inter. That skin
 * is gone. None of those numbers survive the rebuild, so pinning them would be pinning a
 * thing nobody ships. What survives is the FORM of the pin: the design says numbers out
 * loud, and a number that drifts toward whatever a hand reaches for fails here rather than
 * being noticed by nobody.
 *
 * The numbers below are design-refs/new-frontend/peapod-frontend/CONTRACT.md, which is the
 * new source: four radii by role, three faces by job, figures mono and tabular, prose never
 * tabular, and a responsive ladder of 1280 / 1024 / 768 with 16px gutters. Each test names
 * the rule it is holding, so a deliberate change is a visible edit here and not a silent
 * drift there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const web = new URL('../web/', import.meta.url);
const read = (/** @type {string} */ p) => readFile(new URL(p, web), 'utf8');

const tokens = await read('styles/tokens.css');
const PAGES = ['index.html', 'leaderboard.html', 'copy-trade.html', 'asset.html'];
/** @type {Record<string, string>} */
const html = Object.fromEntries(await Promise.all(PAGES.map(async (p) => [p, await read(p)])));
const STYLES = ['tokens', 'base', 'board', 'copy', 'asset', 'landing', 'profile', 'search'];
/** @type {Record<string, string>} */
const css = Object.fromEntries(await Promise.all(STYLES.map(async (n) => [n, await read(`styles/${n}.css`)])));
const ALL_CSS = STYLES.filter((n) => n !== 'tokens').map((n) => css[n]).join('\n');

/** @param {string} name */
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens);
  return m ? m[1].trim() : null;
};

test('the four radii are the contract\'s, and each is on what it is for', () => {
  // "Rectangles: 8px controls, 10px buttons, 14px panels, 20px floating cards."
  const measured = { 'radius-control-sm': '8px', 'radius-button': '10px',
    'radius-panel': '14px', 'radius-card': '20px' };
  for (const [name, value] of Object.entries(measured)) {
    assert.equal(token(name), value, `--${name} drifted from the contract`);
  }
  /*
   * WHERE THE SCALE BINDS. The contract names four radii by ROLE — control, button, panel,
   * card — so those four roles take the token and nothing else. A tile that is 22px wide
   * with an 11px radius is a circle, and a bubble that is 130px wide with a 65px radius is
   * a bubble; pinning every literal in the stylesheet would be pinning the drawing, not the
   * rule, and would fail on the things the contract explicitly allows to be round.
   *
   * So: anything whose selector says it is one of the four roles must use the token. That
   * is the drift this catches — a button at 12px because 12 looked right that day.
   */
  const ROLE = /(^|[.\s>])[\w-]*(btn|button|chip|input|field|select|tab|control|panel|card|seg|toggle)[\w-]*/i;
  /** @type {string[]} */
  const strays = [];
  for (const m of ALL_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const radius = /border-radius:\s*([^;]+)/.exec(m[2]);
    if (!radius) continue;
    const value = radius[1].trim();
    if (/var\(--radius-/.test(value) || /^(50%|999px|9999px|50% 50%|inherit)$/.test(value)) continue;
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      // A knob, a tile, a medal and a bubble are round by nature even when their selector
      // also contains one of the role words.
      if (/avatar|tile|dot|bubble|medal|knob|swatch|mark|square/i.test(sel)) continue;
      if (ROLE.test(sel)) strays.push(`${sel} { border-radius: ${value} }`);
    }
  }
  assert.deepEqual([...new Set(strays)], [],
    `these are controls, buttons, panels or cards and do not take the scale:\n  ${[...new Set(strays)].join('\n  ')}`);
});

test('circles are only for things that are round by nature', () => {
  const round = [...ALL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*border-radius:\s*(?:50%|999px|9999px)[^{}]*)\}/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  /** @type {string[]} */
  const wrong = [];
  for (const sel of round) {
    // avatars, asset tiles, status dots, holder bubbles, medals, and the switch knob.
    if (/avatar|tile|dot|bubble|medal|knob|pill|badge|circle|swatch|spinner|mark|icon|check|sun|moon|toggle|thumb/i.test(sel)) continue;
    wrong.push(sel);
  }
  assert.deepEqual(wrong, [], `these are drawn as circles and are not round by nature: ${wrong.join(', ')}`);
});

test('the three faces are declared, and every page loads all three', () => {
  // Instrument Serif for display, Schibsted Grotesk for UI, JetBrains Mono for figures.
  assert.match(token('font-display') ?? '', /Instrument Serif/);
  assert.match(token('font-display') ?? '', /serif$/, 'the display stack has no generic fallback');
  assert.match(token('font-body') ?? '', /Schibsted Grotesk/);
  assert.match(token('font-body') ?? '', /sans-serif$/);
  assert.match(token('font-mono') ?? '', /JetBrains Mono/);
  assert.match(token('font-mono') ?? '', /monospace$/);
  for (const [name, source] of Object.entries(html)) {
    for (const face of ['Instrument\\+Serif', 'Schibsted\\+Grotesk', 'JetBrains\\+Mono']) {
      assert.match(source, new RegExp(`fonts\\.googleapis\\.com[^"]*${face}`),
        `${name} does not load ${face.replace('\\+', ' ')}`);
    }
  }
});

test('figures are mono and tabular, and prose never is', () => {
  // A money column in a proportional face cannot be compared down its own length. The other
  // half of the rule matters as much: the body face gives a comma a digit's width in
  // tabular mode, so a paragraph set that way comes out gappy.
  assert.match(css.base, /\.(num|mono)[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/,
    'the figure classes lost their tabular figures');
  /** @type {string[]} */
  const onProse = [];
  for (const m of ALL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*font-variant-numeric:\s*tabular-nums[^{}]*)\}/g)) {
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      if (/^(body|main|p|\.prose|article)$/.test(sel)) onProse.push(sel);
    }
  }
  assert.deepEqual(onProse, [], `tabular figures on prose: ${onProse.join(', ')}`);
});

test('the responsive ladder is the contract\'s three steps, and the gutters hold', () => {
  // "Below 1280 a 4-column grid becomes 3, below 1024 it becomes 2, below 768 one, and the
  // page keeps 16px gutters."
  const used = [...new Set([...ALL_CSS.matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)].map((m) => Number(m[1])))];
  assert.ok(used.length >= 3, 'the layout no longer responds at any width');
  const allowed = new Set([1280, 1024, 768, 640, 480, 420]);
  const strays = used.filter((w) => !allowed.has(w));
  assert.deepEqual(strays, [], `breakpoints outside the ladder: ${strays.join(', ')}`);
  for (const w of [1280, 1024, 768]) {
    assert.ok(used.includes(w), `nothing responds at ${w}px`);
  }
  // The narrow gutter is stated once and in pixels, so "it looked fine on my screen" is not
  // the check. A browser pass covers the rest; this only holds the number.
  assert.match(ALL_CSS, /max-width:\s*768px\)[^@]*?(padding|--gutter)[^;]*16px/s,
    'the 16px gutter below 768 is gone');
});

test('the theme is applied before the first stylesheet, on every page', () => {
  // A theme read after paint is a flash of the wrong one. The snippet is inline in <head>,
  // ahead of every stylesheet link, and it is the same string on all four pages.
  /** @type {string[]} */
  const snippets = [];
  for (const [name, source] of Object.entries(html)) {
    const head = source.slice(0, source.indexOf('</head>'));
    const script = /<script>([\s\S]*?)<\/script>/.exec(head);
    assert.ok(script, `${name} has no inline theme snippet`);
    assert.ok(head.indexOf(script[0]) < head.indexOf('<link rel="stylesheet"'),
      `${name} reads the theme after a stylesheet, which is a flash of the wrong theme`);
    assert.match(script[1], /peapod-theme/, `${name}'s snippet does not read the stored theme`);
    assert.match(script[1], /prefers-color-scheme/, `${name} ignores the system preference`);
    assert.match(script[1], /try\s*\{/, `${name}'s snippet is not guarded; blocked storage would break the page`);
    snippets.push(script[1]);
  }
  assert.equal(new Set(snippets).size, 1, 'the pages carry different theme snippets');
});

test('every page links the stylesheets its own module needs, and no others', () => {
  /** @type {Record<string, string[]>} */
  const expected = {
    'index.html': ['tokens', 'base', 'landing'],
    'leaderboard.html': ['tokens', 'base', 'board', 'search', 'profile', 'copy'],
    'copy-trade.html': ['tokens', 'base', 'copy', 'profile', 'search'],
    'asset.html': ['tokens', 'base', 'asset', 'profile', 'search'],
  };
  for (const [page, want] of Object.entries(expected)) {
    const links = [...html[page].matchAll(/href="\/styles\/([\w-]+)\.css"/g)].map((m) => m[1]);
    assert.deepEqual(links, want, `${page} links the wrong stylesheets`);
    // tokens.css first: everything else resolves var()s it defines.
    assert.equal(links[0], 'tokens', `${page} loads tokens.css after something that uses it`);
  }
});

test('there is still no build step: no bare imports, no dependency, no interpolated markup', async () => {
  // The guarantee the whole stack rests on — the file that is served is the file that was
  // written. A bare specifier is the first thing that needs a bundler.
  const libs = (await readdir(new URL('lib/', web))).filter((f) => f.endsWith('.js'));
  assert.ok(libs.length > 8, `only ${libs.length} modules in web/lib`);
  /** @type {string[]} */
  const bare = [];
  /** @type {string[]} */
  const interpolated = [];
  for (const f of libs) {
    const src = await read(`lib/${f}`);
    for (const m of src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('.') && !m[1].startsWith('/')) bare.push(`${f}: ${m[1]}`);
    }
    // Build DOM with node()/createElement, never innerHTML with data in it.
    for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
      if (/[`$]/.test(m[1])) interpolated.push(`${f}: ${m[1].trim().slice(0, 40)}`);
    }
  }
  assert.deepEqual(bare, [], `bare import specifiers need a bundler: ${bare.join(', ')}`);
  assert.deepEqual(interpolated, [], `interpolated innerHTML: ${interpolated.join(', ')}`);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'the site took a runtime dependency');
});
