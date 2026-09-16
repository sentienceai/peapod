/**
 * Static server for peapod. No dependencies, no build step.
 *
 * There is nothing to compile: web/ is served exactly as it sits on disk, which is the
 * same guarantee the engine relies on — the file the parity tests prove is the file the
 * browser loads. In development it also watches web/ and pushes a reload over SSE.
 *
 * Usage:  npm run dev      (PORT and HOST honoured)
 */

import http from 'node:http';
import { mkdir, readFile as readCache, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost } from './net-host.mjs';

const root = fileURLToPath(new URL('./web/', import.meta.url));
const { host, why: hostWhy } = resolveHost();
const port = Number(process.env.PORT || 3000);
const dev = process.env.NODE_ENV !== 'production';

/**
 * Where the data comes from.
 *
 * PEAPOD_STORE as a URL points this server's /api at a deployed peapod instead of a local
 * database, so someone who has just cloned the repository can run the site against real
 * data with no dataset at all. That is the whole point: 256 MB of database is not
 * something to hand a collaborator, and a stale copy is worse than none.
 *
 * Otherwise a local database is opened read-only. With neither, the server says so and
 * names both options rather than serving an empty site that looks broken.
 */
const upstream = (process.env.PEAPOD_STORE || '').replace(/\/$/, '');
const dbPath = process.env.PEAPOD_DB
  || fileURLToPath(new URL('./var/peapod.db', import.meta.url));
const cacheDir = fileURLToPath(new URL('./var/proxy-cache/', import.meta.url));

/** @type {any} */
let api = null;
/** @type {any} */
let apiRoute = null;
/** @type {string | null} */
let storeError = null;

/**
 * Open the store, or serve without one.
 *
 * THIS USED TO EXIT. On a fresh deploy the volume is empty, so there was no database, so
 * the server exited, so the container restarted about once a second, so `railway ssh`
 * could never attach to seed the volume. The container needed data to start and needed to
 * start to receive data. Exiting on missing data is right for a developer who mistyped a
 * path and wrong for a process whose whole job is to come up and then be filled.
 *
 * So a missing store is a STATE, not a failure: /api/manifest answers 200 with build null,
 * the healthcheck passes, the page renders its empty state, and the first cycle fills it.
 * It is also retried on each request, so the server starts serving the moment a build
 * lands without needing a restart.
 */
function openStore() {
  try {
    const mod = /** @type {any} */ (globalThis).__peapodApi;
    api = new mod.Api(dbPath);
    apiRoute = mod.route;
    storeError = null;
    return true;
  } catch (err) {
    api = null;
    storeError = /** @type {Error} */ (err).message;
    return false;
  }
}

if (!upstream) {
  /** @type {any} */ (globalThis).__peapodApi = await import('./web-api.mjs');
  if (!openStore()) {
    console.warn(`no store at ${dbPath} yet (${storeError})`);
    console.warn('serving an empty state; the first cycle will fill it. To build one now: '
      + 'export/build_leaderboard.py. To develop against a deployed one: '
      + 'PEAPOD_STORE=https://<host> npm run dev');
  }
} else {
  console.log(`proxying /api to ${upstream} (read-only)`);
}

/**
 * Proxy one API read upstream, cached on disk by build id.
 *
 * Forwards the path and query and nothing else: no headers, no credentials, no cookies.
 * The cache key carries the upstream build so it invalidates when the deployment moves
 * rather than going quietly stale, and it means iterating on a page does not hammer
 * production or need a network at all after the first pass.
 * @param {string} pathname @param {string} search
 */
async function proxy(pathname, search) {
  const build = await currentBuild();
  const key = createHash('sha256').update(`${build}|${pathname}${search}`).digest('hex');
  const file = `${cacheDir}${key}.json`;
  try {
    const hit = await readCache(file);
    return { status: 200, body: hit, type: 'application/json', gzip: true };
  } catch { /* not cached yet */ }
  const res = await fetch(`${upstream}${pathname}${search}`);
  // fetch decompresses transparently, so re-compress before caching and serving. Without
  // this a proxied response goes out four times the size the store holds, and the same
  // route behaves differently depending on where the data came from — which is exactly
  // what the API-as-contract is meant to prevent.
  const body = gzipSync(Buffer.from(await res.arrayBuffer()), { level: 6 });
  if (res.ok) {
    await mkdir(cacheDir, { recursive: true }).catch(() => {});
    await writeFile(file, body).catch(() => {});
  }
  return { status: res.status, body, type: 'application/json', gzip: true };
}

/**
 * What /api answers before the first build exists.
 *
 * The manifest is a 200 so the deploy healthcheck passes — the service IS healthy, it
 * simply has nothing yet — and it says so in a field the page can read. Everything else is
 * a 503 with the same explanation, which is honest: not found is wrong when the answer is
 * "not yet".
 * @param {URL} url
 */
function emptyState(url) {
  const body = {
    build: null, built_at: null, addresses: 0, qualifying: 0,
    windows: [], scopes: [], empty: true,
    detail: `no store at ${dbPath} yet; the first cycle will build one`,
  };
  const manifest = url.pathname.replace(/\/$/, '').endsWith('/manifest');
  return { status: manifest ? 200 : 503, body: JSON.stringify(body),
           type: 'application/json' };
}

/** @type {{value: string, at: number}} */
let buildCache = { value: 'unknown', at: 0 };
async function currentBuild() {
  if (Date.now() - buildCache.at < 60_000) return buildCache.value;
  try {
    const r = await fetch(`${upstream}/api/manifest`);
    const m = await r.json();
    buildCache = { value: String(m.build ?? 'unknown'), at: Date.now() };
  } catch {
    buildCache = { value: 'offline', at: Date.now() };
  }
  return buildCache.value;
}

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    const url = new URL(req.url || '/', `http://${host}`);
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith('/api')) {
      // Retry the open on each request: a store that appears after boot should start
      // being served without a restart.
      if (!upstream && !api) openStore();
      const out = upstream
        ? await proxy(path, url.search)
        : (api ? apiRoute(api, url) : emptyState(url));
      const headers = /** @type {Record<string, string>} */ ({
        'Content-Type': `${out.type}; charset=utf-8`,
        'Content-Length': String(Buffer.byteLength(out.body)),
        'Cache-Control': dev ? 'no-store' : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      });
      if (out.gzip) headers['Content-Encoding'] = 'gzip';
      res.writeHead(out.status, headers);
      res.end(req.method === 'HEAD' ? undefined : out.body);
      return;
    }

    if (dev && path === '/__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // A path with no extension is a page: /traders serves traders.html. Without this the
    // nav would have to carry .html into every link and every browser history entry.
    const asPage = path === '/' ? '/index.html' : (extname(path) ? path : `${path}.html`);
    const file = resolve(root, '.' + asPage);
    // Never serve outside web/, whatever the request says.
    if (file !== root.replace(/\/$/, '') && !file.startsWith(root.replace(/\/$/, '') + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(file);
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8`,
      'Content-Length': body.length,
      'Cache-Control': dev ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
    // A 500 with no explanation cost an afternoon of deploy debugging. Say what broke.
    if (!missing) console.error('request failed:', error);
    res.writeHead(missing ? 404 : 500);
    res.end(missing ? 'Not found' : 'Server error');
  }
});

if (dev) {
  let timer;
  watch(root, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of clients) client.write('data: reload\n\n');
    }, 80);
  });
}

server.listen(port, host, () => {
  const bound = /** @type {any} */ (server.address());
  console.log(`peapod on http://${bound.address}:${bound.port} (${hostWhy})`);
  if (bound.address === '127.0.0.1' && process.env.NODE_ENV === 'production') {
    // A production process on loopback answers every check made inside the container and
    // 502s every request from outside it. Say so rather than letting it look healthy.
    console.warn('WARNING: listening on loopback in production. A platform proxy cannot '
      + 'reach this. Set HOST=0.0.0.0.');
  }
});

// What it actually bound to, for anything that needs to assert it from outside.
export const listening = () => /** @type {any} */ (server.address());

process.on('SIGTERM', () => {
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
});
