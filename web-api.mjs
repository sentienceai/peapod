/**
 * The read API. This is the contract, not the file layout.
 *
 * Everything the page reads goes through /api, so where the bytes live stops mattering to
 * the front end — which is what lets a second developer point a local dev server at the
 * deployed store instead of needing 256 MB of database. See PEAPOD_STORE in server.mjs.
 *
 * PAYLOADS ARE SERVED EXACTLY AS STORED. Detail and leaderboard blobs are gzipped in the
 * database and go out with Content-Encoding: gzip untouched, so a request costs a single
 * indexed lookup and no decompression on either the CPU or the way in.
 *
 * READ ONLY. There is no write route, which is what makes the dev proxy safe to point at
 * production: there is nothing to forward that could change anything.
 */

import { DatabaseSync } from 'node:sqlite';

const HEX40 = /^0x[0-9a-f]{40}$/;
const NAME = /^[a-z0-9-]{1,32}$/;

export class Api {
  /** @param {string} path */
  constructor(path) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec('PRAGMA query_only=1');
    // Opening a path that does not exist SUCCEEDS — you get a handle onto an empty
    // database, and every query then fails with "no such table" at request time instead
    // of at open time. So the schema is the thing that decides whether a store is there.
    const table = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='address'").get();
    if (!table) {
      this.db.close();
      throw new Error(`no peapod schema at ${path}`);
    }
  }

  /** @param {string} key */
  meta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(/** @type {string} */ (row.value)) : null;
  }

  manifest() {
    const counts = this.db.prepare(
      'SELECT COUNT(*) AS addresses, SUM(round_trips > 0) AS qualifying FROM address').get();
    return {
      build: this.meta('build'),
      built_at: this.meta('built_at'),
      source: this.meta('source'),
      windows: this.meta('windows'),
      scopes: this.meta('scopes'),
      addresses: Number(counts?.addresses ?? 0),
      qualifying: Number(counts?.qualifying ?? 0),
    };
  }

  /** @param {string} scope @param {string} window */
  leaderboard(scope, window) {
    if (!NAME.test(scope) || !NAME.test(window)) return null;
    const row = this.db.prepare(
      'SELECT payload FROM leaderboard WHERE scope=? AND window=?').get(scope, window);
    return row ? Buffer.from(/** @type {Uint8Array} */ (row.payload)) : null;
  }

  /** @param {string} addr */
  address(addr) {
    if (!HEX40.test(addr)) return null;
    const row = this.db.prepare('SELECT payload FROM address WHERE addr=?').get(addr);
    return row ? Buffer.from(/** @type {Uint8Array} */ (row.payload)) : null;
  }

  /**
   * Prefix search over a million rows, answered by the primary key index rather than a
   * scan. Ranked rows first, because someone typing a fragment is usually looking for a
   * name they saw on the board.
   * @param {string} q @param {number} limit
   */
  search(q, limit = 10) {
    const term = String(q || '').toLowerCase();
    if (!/^0x[0-9a-f]{2,40}$/.test(term)) return [];
    return this.db.prepare(
      'SELECT addr, realized, round_trips, status FROM address '
      + 'WHERE addr >= ? AND addr < ? ORDER BY round_trips DESC, realized DESC LIMIT ?')
      .all(term, `${term}￿`, Math.min(Number(limit) || 10, 50));
  }

  close() { this.db.close(); }
}

/**
 * Route one request. Returns null when the path is not an API path, so the caller can
 * fall through to static files.
 * @param {Api} api @param {URL} url
 * @returns {{status: number, body: Buffer|string, type: string, gzip?: boolean}|null}
 */
export function route(api, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  if (!url.pathname.startsWith('/api')) return null;
  const json = (/** @type {any} */ o, status = 200) => ({
    status, body: JSON.stringify(o), type: 'application/json' });

  if (parts[0] === 'manifest') return json(api.manifest());
  if (parts[0] === 'search') return json({ results: api.search(url.searchParams.get('q') || '') });
  if (parts[0] === 'leaderboard') {
    const body = parts[1] === 'index'
      ? api.leaderboard('index', 'index') : api.leaderboard(parts[1], parts[2]);
    if (!body) return json({ error: 'no such view' }, 404);
    return { status: 200, body, type: 'application/json', gzip: true };
  }
  if (parts[0] === 'address') {
    const body = api.address(String(parts[1] || '').toLowerCase());
    // Absent is a real answer here: most addresses on this chain never traded.
    if (!body) return json({ error: 'not in this tape' }, 404);
    return { status: 200, body, type: 'application/json', gzip: true };
  }
  return json({ error: 'no such route' }, 404);
}
