/**
 * The site as a whole: its routes, its seam, and the claims it is allowed to make.
 *
 * WHAT THIS FILE INHERITS. The old suite pinned these against pages that no longer exist —
 * an API that is read-only, a dev server that can run against a deployed store, a footer
 * that names the build, and a page that never says more than it can measure. The frontend
 * was rebuilt from the design frames; the rules did not change, so the pins moved here
 * rather than being dropped with the files they used to point at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
/** The real network fetch, taken before any DOM stub can replace the global one. */
const netFetch = globalThis.fetch.bind(globalThis);

const PAGES = ['index.html', 'leaderboard.html', 'copy-trade.html', 'asset.html'];
const LIB = (await readdir(new URL('../web/lib/', import.meta.url))).filter((f) => f.endsWith('.js'));
/** @type {Record<string, string>} */
const SRC = Object.fromEntries(await Promise.all(
  [...LIB.map((f) => `lib/${f}`), ...PAGES].map(async (f) => [f, await readFile(new URL(`../web/${f}`, import.meta.url), 'utf8')])));

/** @param {Record<string, string>} env */
async function boot(env = {}) {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = 3700 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.mjs'],
      { cwd: root, env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 60 && child.exitCode === null; i += 1) {
      await new Promise((r) => { setTimeout(r, 100); });
      try {
        await netFetch(`http://127.0.0.1:${port}/api/manifest`);
        return { base: `http://127.0.0.1:${port}`, child, log: () => log };
      } catch { /* not up yet */ }
    }
    child.kill('SIGKILL');
    last = log;
  }
  throw new Error(`server never came up:\n${last}`);
}

test('every page of the site answers on its own URL, and the old one redirects', async () => {
  const s = await boot();
  try {
    // Extensionless, because a URL is part of the interface: /leaderboard reads as a place,
    // /leaderboard.html reads as a file someone forgot to route.
    for (const [path, needle] of /** @type {[string, RegExp][]} */ ([
      ['/', /Peapod/], ['/leaderboard', /Traders leaderboard/], ['/copy-trade', /Copy trade/],
      ['/asset?symbol=TSLA', /Asset/],
    ])) {
      const res = await netFetch(`${s.base}${path}`);
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
      assert.match(await res.text(), needle, `${path} served the wrong page`);
    }
    // /traders was the old copy-trade page and links to it are out in the world.
    const moved = await netFetch(`${s.base}/traders`, { redirect: 'manual' });
    assert.equal(moved.status, 302, 'the old traders URL no longer redirects');
    assert.equal(moved.headers.get('location'), '/copy-trade');

    // The endpoints the frontend reads, including the two new ones.
    for (const path of ['/api/manifest', '/api/leaderboard/all/7d', '/api/assets', '/api/asset/TSLA']) {
      assert.equal((await netFetch(`${s.base}${path}`)).status, 200, `${path} is not served`);
    }
    // Absent is a real answer, and a symbol that could never be one is the same answer.
    for (const path of ['/api/asset/NOPE', '/api/address/0xabababababababababababababababababababab']) {
      assert.equal((await netFetch(`${s.base}${path}`)).status, 404, `${path} should be 404`);
    }
  } finally {
    s.child.kill('SIGKILL');
  }
});

test('the API is the contract, and it is read-only', async () => {
  const src = await readFile(new URL('../web-api.mjs', import.meta.url), 'utf8');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ATTACH']) {
    assert.ok(!src.includes(verb), `the read API contains ${verb}`);
  }
  assert.match(src, /readOnly: true/);
  assert.match(src, /query_only=1/);
  // And nothing that is not an address or a symbol reaches a query.
  const { Api, route } = await import('../web-api.mjs');
  const api = new Api(process.env.PEAPOD_DB || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));
  try {
    for (const bad of ['0xzz', 'select', '0x1234', "0x' OR 1=1--", '0xABCDEF']) {
      assert.equal(/** @type {any} */ (route(api, new URL(`http://x/api/address/${encodeURIComponent(bad)}`)))?.status,
        404, bad);
    }
    for (const bad of ['../etc', 'TSLA;drop', 'a'.repeat(20)]) {
      assert.equal(/** @type {any} */ (route(api, new URL(`http://x/api/asset/${encodeURIComponent(bad)}`)))?.status,
        404, bad);
    }
    const ok = /** @type {any} */ (route(api, new URL('http://x/api/assets')));
    assert.equal(ok.status, 200);
    assert.equal(ok.gzip, true, 'payloads must go out compressed, as stored');
  } finally {
    api.close();
  }
});

test('lib/data.js is the only module that knows a URL', () => {
  /*
   * THE SEAM. Every page asks data.js and nothing else; no page fetches, no page builds a
   * path. It is what made pointing this frontend at a real backend one file's worth of work
   * rather than forty, and it is the thing that quietly stops being true.
   */
  /** @type {string[]} */
  const offenders = [];
  for (const [file, src] of Object.entries(SRC)) {
    if (file === 'lib/data.js' || !file.startsWith('lib/')) continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/\bfetch\s*\(/.test(code)) offenders.push(`${file}: fetch(`);
    if (/['"`]\/api\//.test(code)) offenders.push(`${file}: an /api path`);
  }
  assert.deepEqual(offenders, [], `these bypass the seam:\n  ${offenders.join('\n  ')}`);
});

test('nothing in the frontend can ask a wallet for anything', () => {
  // Until execution exists there is nothing a provider call could be for. When it does, this
  // test is the line in the diff where that changes — deliberately, not by accident.
  /** @type {string[]} */
  const offenders = [];
  for (const [file, src] of Object.entries(SRC)) {
    for (const pattern of [/\beth_\w+/, /window\.ethereum|globalThis\.ethereum/, /personal_sign|signTypedData/]) {
      if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `these reach for a wallet:\n  ${offenders.join('\n  ')}`);
});

test('no page claims a thing this build cannot do', () => {
  /*
   * THE CLAIMS THE FRAMES CAME WITH. The reference screens were drawn for a product with
   * execution: "Your portfolio, on autopilot", "Every trade they make is copied to your
   * wallet in real time", "Always-on execution", "Live from Robinhood Chain", a Connect
   * wallet button. None of it is true here — nothing places, copies or simulates a trade,
   * and the figures are a build of the swap tape, not a live feed.
   *
   * The phrases below are the ones that were actually on these pages and had to go. A page
   * may still SAY the feature is coming; it may not describe it in the present tense.
   */
  const banned = [
    /on autopilot/i, /copied to your wallet/i, /always-on execution/i,
    /live from robinhood/i, /mirrors within seconds/i, /in real time/i,
    /\bconnect wallet\b/i, /copy score.{0,12}\/\s*100/i,
  ];
  /** @type {string[]} */
  const found = [];
  for (const [file, src] of Object.entries(SRC)) {
    // Comments are stripped first: several of these phrases survive in the source as the
    // note saying what the claim used to be and why it could not stay, which is the record
    // of the decision rather than a thing the page says to anybody.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    for (const re of banned) {
      const hit = re.exec(code);
      if (hit) found.push(`${file}: "${hit[0]}"`);
    }
  }
  assert.deepEqual(found, [], `claims this build cannot keep:\n  ${found.join('\n  ')}`);
});

test('the sample mark is per figure, not per page', async () => {
  /*
   * WHY THIS SHAPE. A single "this build is sample data" flag disappears the moment the
   * rows go live — including from the figures beside them that are still invented, which
   * are then the ones nobody is warned about. So a payload names its own sample fields and
   * each figure asks about itself.
   */
  const { isSampleField } = await import('../web/lib/data.js');
  assert.equal(isSampleField({ sampleFields: ['holders'] }, 'holders'), true);
  assert.equal(isSampleField({ sampleFields: ['holders'] }, 'price'), false);
  assert.equal(isSampleField({ sampleFields: [] }, 'price'), false);
  assert.equal(isSampleField(null, 'price'), false);

  // And the live payloads say they are live, field by field, rather than by a global flag.
  const { board, meta, assets } = await import('../web/lib/data.js');
  const { Api, route } = await import('../web-api.mjs');
  const api = new Api(process.env.PEAPOD_DB || fileURLToPath(new URL('../var/peapod.db', import.meta.url)));
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ path) => {
    const out = /** @type {any} */ (route(api, new URL(`http://stub${path}`)));
    const { gunzipSync } = await import('node:zlib');
    const text = out.gzip ? gunzipSync(Buffer.from(out.body)).toString('utf8') : String(out.body);
    return { ok: out.status < 400, status: out.status, json: async () => JSON.parse(text) };
  });
  try {
    for (const payload of [await meta(), await board(), { sampleFields: [], rows: await assets() }]) {
      assert.deepEqual(payload.sampleFields, [], 'a live payload claims to be sample data');
    }
  } finally {
    globalThis.fetch = original;
    api.close();
  }
});

test('a store older than the asset endpoints does not take the leaderboard down with it', async () => {
  /*
   * THE DEPLOY THIS COMES FROM. The asset tables are written by the cycle, so for a cycle
   * or two after a deploy — and on any rollback — /api/assets answers 404 over a store whose
   * rankings are sitting right there. assets() threw, board.js awaited it before painting,
   * and the live leaderboard rendered zero rows. A page missing its tile colours is a much
   * smaller loss than a page.
   */
  const { assets } = await import('../web/lib/data.js');
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ path) => (
    path.startsWith('/api/assets')
      ? { ok: false, status: 404, json: async () => ({ error: 'no assets in this build' }) }
      : original(path)));
  try {
    assert.deepEqual(await assets(), [], 'a build without the asset tables should answer with none');
  } finally {
    globalThis.fetch = original;
  }
});

test('the footer names the build every page is showing', () => {
  // A proxied session, a stale container and a fresh deploy look identical otherwise, and a
  // bug report has to be able to say which build it saw.
  assert.match(SRC['lib/chrome.js'], /Build /);
  assert.match(SRC['lib/chrome.js'], /meta\?\.build/);
});

test('the dev server still runs against a deployed store, and says what it is serving', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /PEAPOD_STORE/, 'the server has no remote-store mode');
  assert.match(src, /proxying \/api to/);
  const from = src.indexOf('async function proxy(');
  const proxyFn = src.slice(from, src.indexOf('\n}\n', from));
  assert.ok(!/headers:/.test(proxyFn), 'the proxy forwards headers upstream');
  assert.ok(!/GOLDSKY|API_KEY|Authorization/i.test(proxyFn));
  assert.match(proxyFn, /createHash/, 'proxied reads are not cached');
  assert.match(proxyFn, /gzipSync/);
  assert.match(src, /serving an empty state; the first cycle will fill it/);
});
