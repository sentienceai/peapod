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
    // A symbol that is not ASCII arrives percent-encoded and must be decoded before the
    // lookup: three Pons tokens are named in emoji or Chinese, and answering 404 for exactly
    // those is the failure the widened alphabet exists to prevent — hiding as "not in this
    // tape". Checked against whatever the build actually shipped, so it stays true on a
    // store whose tape has not reached those tokens yet.
    const { gunzipSync } = await import('node:zlib');
    const listOut = /** @type {any} */ (route(api, new URL('http://x/api/assets')));
    if (listOut.status === 200) {
      const list = JSON.parse(gunzipSync(Buffer.from(listOut.body)).toString('utf8'));
      const odd = list.filter((/** @type {any} */ a) => ![...a.symbol].every((/** @type {string} */ c) => c.charCodeAt(0) < 128));
      for (const a of odd.slice(0, 3)) {
        const res = /** @type {any} */ (route(api, new URL(`http://x/api/asset/${encodeURIComponent(a.symbol)}`)));
        assert.equal(res.status, 200, `${a.symbol} is listed but cannot be opened`);
      }
      // Deterministic on any store, including one whose tape holds no such token yet:
      // TS%4CA is "TSLA" with one letter percent-encoded, so it resolves only if the route
      // decodes before it looks up.
      if (list.some((/** @type {any} */ a) => a.symbol === 'TSLA')) {
        assert.equal(/** @type {any} */ (route(api, new URL('http://x/api/asset/TS%4CA'))).status, 200,
          'the route is not percent-decoding the symbol');
      }
      // A malformed escape is an unknown symbol, not a crash.
      assert.equal(/** @type {any} */ (route(api, new URL('http://x/api/asset/%E0%A4%A'))).status, 404);
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

test('the wallet asks for addresses and nothing else', async () => {
  /*
   * CONNECT ONLY. The control asks a wallet for its addresses; it never asks for a
   * signature, a transaction or a chain switch. There is nothing here to authorise, and a
   * signature request is the one prompt that makes a read-only site look like it wants
   * something. This is asserted on the SOURCE rather than on a rendered button, because a
   * render test passes happily while a second method sits in a branch nobody clicked.
   */
  /** @type {string[]} */
  const offenders = [];
  for (const [file, src] of Object.entries(SRC)) {
    for (const m of src.matchAll(/'(eth_[a-zA-Z]+|personal_sign|wallet_[a-zA-Z]+)'/g)) {
      if (m[1] !== 'eth_requestAccounts') offenders.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `these ask a wallet for more than addresses:\n  ${offenders.join('\n  ')}`);
  // Not vacuous: the one permission the site does use is still there, and it is the only one.
  assert.match(SRC['lib/wallet.js'], /eth_requestAccounts/);

  // A dismissed prompt is a refusal, not a connection.
  const { connect } = await import('../web/lib/wallet.js');
  await assert.rejects(() => connect({ async request() { return []; } }), /no account authorised/);
  await assert.rejects(() => connect({ async request() { return ['not-an-address']; } }), /no account authorised/);
  await assert.rejects(() => connect(null), /no wallet provider/);
});

test('no page that shows data claims a thing this build cannot do', () => {
  /*
   * TWO DIFFERENT KINDS OF PAGE, and the rule is not the same for both.
   *
   * The APP pages — the board, the copy grid, markets, the asset page and the dialogs —
   * describe data that is on the screen. A sentence there is read as a statement about the
   * figures beside it, so "copied to your wallet in real time" or "live from Robinhood
   * Chain" is a claim about what this build does, and it is false.
   *
   * The LANDING page sells a product that is being built. Copy trading is coming, and the
   * page says so in the frames' own voice; what it may not do is put a thing that does not
   * happen into the present tense, or state a figure nothing measured. That second half is
   * covered by the test below it, which is the one that actually holds.
   */
  const banned = [
    // Not "account value" or "Sharpe": those two words appear on the app pages as the
    // NAMES of slots saying the figure needs the transfer index, which is the opposite of
    // claiming them.
    /live from robinhood/i, /copied to your wallet/i, /mirrors within seconds/i,
    /copy score.{0,12}\/\s*100/i, /on autopilot/i,
  ];
  const appPages = Object.entries(SRC).filter(([f]) =>
    f !== 'index.html' && f !== 'lib/landing.js');
  /** @type {string[]} */
  const found = [];
  for (const [file, src] of appPages) {
    // Comments are stripped: several of these phrases survive as the note saying what the
    // claim used to be and why it could not stay, which is the record of the decision
    // rather than a thing the page says to anybody.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    for (const re of banned) {
      const hit = re.exec(code);
      if (hit) found.push(`${file}: "${hit[0]}"`);
    }
  }
  assert.deepEqual(found, [], `claims on a page that shows data:\n  ${found.join('\n  ')}`);
});

test('the landing page sells what is coming without measuring what it cannot', () => {
  /*
   * The landing page may say copy trading is coming, in the frames' voice. The line it may
   * not cross is a FIGURE: a volume, a user count, a latency, an uptime, a price, an API
   * statistic — anything shaped like a measurement that nothing measured. Every number on
   * that page has to come from lib/data.js at runtime, which is why landing.js computes its
   * stats and index.html carries almost none.
   */
  const html = SRC['index.html'].replace(/<!--[\s\S]*?-->/g, ' ');
  // Text nodes only: class names, viewBox numbers and inline SVG path data are not claims.
  const text = html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  /*
   * Figure-shaped things, not sentences: a dollar amount, or a count with a unit that only
   * a measurement would carry. Ordinals ("01 Stocks"), durations in the copy ("24-hour
   * volume") and the window itself are not claims about what this product has done.
   */
  /** @type {string[]} */
  const figures = [];
  for (const m of text.matchAll(/\$\s?\d[\d,.]*\s?[MBK]?/g)) figures.push(m[0].trim());
  for (const m of text.matchAll(/\b\d[\d,.]*\s*(ms\b|users?\b|customers?\b|copied trades?\b|wallets copied\b|uptime)/gi)) {
    figures.push(m[0].trim());
  }
  assert.deepEqual(figures, [],
    `figures on the landing page that nothing measured:\n  ${figures.join('\n  ')}`);
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
