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
/**
 * Whether a symbol can be carried by /api/asset/:symbol.
 *
 * WIDE ON PURPOSE, and kept in step by hand with addressable() in
 * export/build_leaderboard.py. The alphabet was [A-Za-z0-9.]{1,16}, which could not spell
 * three Pons tokens named in emoji and Chinese — and the board lists those tokens in its
 * rows, so the asset list disagreed with the leaderboard about what exists. A symbol is
 * data from the chain rather than a name we choose; a URL only needs it to percent-encode
 * and round-trip.
 *
 * Refused: a path separator, the two reserved dot names, any control character, empty, and
 * anything past 32 characters. The value never reaches SQL as anything but a bound
 * parameter, and never touches the filesystem at all.
 * @param {string} symbol
 */
const addressable = (symbol) => Boolean(symbol) && symbol !== '.' && symbol !== '..'
  && [...symbol].length <= 32 && !/[/\\\u0000-\u001f\u007f]/.test(symbol);

export class Api {
  /** @param {string} path */
  constructor(path) {
    /** @type {DatabaseSync} */
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec('PRAGMA query_only=1');
    // Opening a path that does not exist SUCCEEDS — you get a handle onto an empty
    // database, and every query then fails with "no such table" at request time instead
    // of at open time. So the schema is the thing that decides whether a store is there.
    if (!this.has('address')) {
      this.db.close();
      throw new Error(`no peapod schema at ${path}`);
    }
  }

  /**
   * Whether a table is there, asked every time rather than cached at open.
   *
   * A store built before a table existed is a normal state — the volume holds whatever the
   * last cycle wrote — and the next cycle adds it under this same connection, so a set
   * captured at boot would keep a live server answering 404 for data that had already
   * landed. It is one lookup against a table of a dozen rows.
   * @param {string} name
   */
  has(name) {
    return !!this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
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
   * Every asset in this build, as one stored blob.
   *
   * Null rather than an empty list when the table is absent, so a store written before
   * these tables existed answers 404 the way a missing leaderboard does instead of
   * throwing "no such table" out of a request handler — and instead of claiming, with an
   * empty array, that this build traded nothing.
   */
  assets() {
    if (!this.has('asset_list')) return null;
    const row = this.db.prepare('SELECT payload FROM asset_list WHERE id=?').get('assets');
    return row ? Buffer.from(/** @type {Uint8Array} */ (row.payload)) : null;
  }

  /**
   * One asset. The symbol is matched exactly as the build stored it: tickers are
   * upper-case on this tape, and folding case here would merge two symbols that SQLite,
   * and the chain, consider different.
   * @param {string} symbol
   */
  asset(symbol) {
    if (!addressable(symbol) || !this.has('asset')) return null;
    const row = this.db.prepare('SELECT payload FROM asset WHERE symbol=?').get(symbol);
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
  if (parts[0] === 'assets') {
    const body = api.assets();
    if (!body) return json({ error: 'no assets in this build' }, 404);
    return { status: 200, body, type: 'application/json', gzip: true };
  }
  if (parts[0] === 'asset') {
    /*
     * PERCENT-DECODED FIRST. A symbol is data from the chain, and three tokens on this tape
     * are named in emoji or Chinese — so the path segment arrives encoded and the stored
     * symbol is the decoded one. Looking up the raw segment answers 404 for exactly the
     * symbols the widened alphabet was meant to let through, which is a bug that hides as
     * "not in this tape". decodeURIComponent throws on a malformed sequence; that is a
     * symbol no URL could have carried, so it is the same 404 as any other unknown one.
     */
    let symbol = '';
    try {
      symbol = decodeURIComponent(String(parts[1] || ''));
    } catch {
      symbol = '';
    }
    const body = api.asset(symbol);
    // Same answer for a symbol this build never carried and for one that is not a symbol
    // at all: the caller learns the route holds nothing for it, and nothing else.
    if (!body) return json({ error: 'not in this tape' }, 404);
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
