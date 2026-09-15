/**
 * Enforces that no test file loses tests without someone saying so.
 *
 * WHY. Restructuring a test file by slicing between two string boundaries removes whatever
 * sits between them, and if a boundary is wrong that includes tests nobody meant to touch.
 * It happened twice here. The first time a type checker caught it by flagging an import
 * that had become unused; the second time the same way. That is luck, not a check — a
 * deleted test whose imports are still used by its neighbours leaves no trace at all, and
 * the suite goes green with less in it than before.
 *
 * So the count is the check. `test/expected-counts.json` is a floor per file. Adding tests
 * is free. Removing one fails here, and removing one deliberately means updating the floor
 * with `scripts/test-census.sh --update`, which is a visible line in a diff.
 *
 * This does not verify that tests are meaningful, only that they still exist. It is a
 * tripwire, not a quality measure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const expected = JSON.parse(
  await readFile(new URL('test/expected-counts.json', root), 'utf8'),
);

/** @param {string} path @returns {Promise<number>} */
async function countTests(path) {
  const source = await readFile(new URL(path, root), 'utf8');
  const pattern = path.endsWith('.py') ? /^\s+def test_/gm : /^test\(/gm;
  return (source.match(pattern) || []).length;
}

test('no suite file has lost tests', async () => {
  /** @type {string[]} */
  const shrunk = [];
  for (const [path, floor] of Object.entries(expected)) {
    const actual = await countTests(path);
    if (actual < floor) {
      shrunk.push(`${path}: ${floor} -> ${actual} (${floor - actual} gone)`);
    }
  }
  assert.deepEqual(shrunk, [],
    'tests disappeared. If deliberate, run scripts/test-census.sh --update so the '
    + 'removal is a visible line in the diff:\n  ' + shrunk.join('\n  '));
});

test('every suite file is covered by the census', async () => {
  // A file absent from the manifest could be emptied entirely without failing anything.
  const found = [];
  for (const [dir, suffix] of [['test', '.test.mjs'], ['export', '.py'], ['ingest', '.py']]) {
    for (const name of await readdir(new URL(`${dir}/`, root))) {
      const isTest = suffix === '.py' ? name.startsWith('test_') && name.endsWith('.py')
        : name.endsWith(suffix);
      if (isTest && name !== 'counts.test.mjs') found.push(`${dir}/${name}`);
    }
  }
  const missing = found.filter((f) => !(f in expected));
  assert.deepEqual(missing, [],
    'suite files not in the census; run scripts/test-census.sh --update');
});

test('the census matches what the runners actually collect', async () => {
  // Guards the counting itself: if the regex drifts from what node:test and pytest see,
  // the floor silently stops meaning anything.
  const jsFiles = Object.keys(expected).filter((p) => p.endsWith('.mjs'));
  let counted = 0;
  for (const path of jsFiles) counted += await countTests(path);
  assert.ok(counted > 40, `census sees only ${counted} JS tests, which cannot be right`);
});
