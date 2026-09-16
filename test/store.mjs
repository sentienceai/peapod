/**
 * Read the shipped store the way the API does, for tests that need many addresses.
 *
 * Tests used to walk web/data/address/**.json. Those files are gone — 103,920 of them was
 * 580 MB and five times a static host's file cap — so the assertions they made now have to
 * be made against the database the server actually serves.
 */

import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const path = process.env.PEAPOD_DB
  || fileURLToPath(new URL('../var/peapod.db', import.meta.url));
const db = new DatabaseSync(path, { readOnly: true });

/** @param {string} sql @param {any[]} args */
const all = (sql, args = []) => db.prepare(sql).all(...args);

/** @param {Uint8Array} blob */
const unpack = (blob) => JSON.parse(gunzipSync(Buffer.from(blob)).toString('utf8'));

/** @param {string} addr */
export function detail(addr) {
  const row = db.prepare('SELECT payload FROM address WHERE addr=?').get(addr);
  return row ? unpack(/** @type {any} */ (row.payload)) : null;
}

/** A sample of stored details, for assertions that need breadth rather than one row.
 * @param {{where?: string, args?: any[], limit?: number}} [opts] */
export function sample(opts = {}) {
  const where = opts.where ? `WHERE ${opts.where}` : '';
  return all(`SELECT payload FROM address ${where} LIMIT ?`,
    [...(opts.args ?? []), opts.limit ?? 200])
    .map((r) => unpack(/** @type {any} */ (r.payload)));
}

/** @param {string} sql @param {any[]} [args] @returns {number} */
export function scalar(sql, args = []) {
  const row = db.prepare(sql).get(...args);
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

export { all };

/**
 * A leaderboard payload, from the store rather than from a file.
 *
 * Tests read these off disk until the store landed, and two of them were still reading
 * rwa-usdg-all.json — a scope the build stopped producing when Pons went in. It was
 * passing against a fossil. Reading through the store means a test can only assert
 * against something a build actually made.
 * @param {string} scope @param {string} window
 */
export function view(scope, window) {
  const row = db.prepare('SELECT payload FROM leaderboard WHERE scope=? AND window=?')
    .get(scope, window);
  if (!row) throw new Error(`no leaderboard for ${scope}/${window} in the store`);
  return unpack(/** @type {any} */ (row.payload));
}

/** The scope and window index, as the API serves it. */
export const index = () => view('index', 'index');
