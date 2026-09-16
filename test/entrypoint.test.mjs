/**
 * The entrypoint must hand over to the server from ANY volume state.
 *
 * deploy.test.mjs boots server.mjs directly, so it never ran this file — and this file is
 * what the container actually executes first. A reporting block that counted files with
 * `ls | wc -l` under `set -eo pipefail` exited 2 on an empty directory, silently, before
 * printing anything or reaching exec. The container crash-looped several times a second
 * on a volume that was working perfectly, and every test passed.
 *
 * So these run the real script, with the real shell options, against the volume states a
 * container sees: empty, partly ingested, and fully built.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/entrypoint.sh', import.meta.url));

/**
 * Run the real entrypoint with a sandbox volume, returning what it printed.
 * @param {((data: string) => Promise<void>) | undefined} [build] seed the volume
 * @param {string[]} [argv] what follows the entrypoint; [] is the container's own case
 */
async function boot(build, argv = ['echo', 'HANDED-OVER']) {
  const data = await mkdtemp(join(tmpdir(), 'peapod-vol-'));
  const app = await mkdtemp(join(tmpdir(), 'peapod-app-'));
  await mkdir(join(app, 'ingest'), { recursive: true });
  if (build) await build(data);
  try {
    const { stdout } = await run('bash', [script, ...argv], {
      env: { ...process.env, PEAPOD_DATA: data, PEAPOD_APP: app },
    });
    return { out: stdout, data, app };
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(app, { recursive: true, force: true });
  }
}

test('it hands over on a completely empty volume', async () => {
  const { out } = await boot();
  assert.match(out, /HANDED-OVER/, 'the entrypoint never reached exec');
  assert.match(out, /volume: 0 swap parts, 0 identity parts, 0 day partitions/);
  assert.match(out, /no build yet/);
  assert.match(out, /no swap tape yet/);
});

test('it hands over on a partly ingested volume and counts what is there', async () => {
  // The state the container is in after a redeploy interrupts a first ingest: swap parts
  // and a checkpoint, but no day partitions and no database.
  const { out } = await boot(async (/** @type {string} */ data) => {
    await mkdir(join(data, 'ingest-out', 'swaps_tx'), { recursive: true });
    for (const n of ['00000', '00001', '00002']) {
      await writeFile(join(data, 'ingest-out', 'swaps_tx', `part-${n}.parquet`), 'x');
    }
    await writeFile(join(data, 'ingest-out', 'swaps_tx.checkpoint.json'),
      JSON.stringify({ cursor: 61017501, part: 3, rows: 20030 }));
  });
  assert.match(out, /HANDED-OVER/);
  assert.match(out, /3 swap parts/);
  assert.match(out, /cursor 61017501/, 'the cursor is not reported');
  assert.match(out, /no build yet/);
  assert.ok(!/no swap tape yet/.test(out), 'it claimed no tape while three parts exist');
});

test('it hands over on a fully built volume and says nothing is missing', async () => {
  const { out } = await boot(async (/** @type {string} */ data) => {
    await mkdir(join(data, 'ingest-out', 'swaps_tx'), { recursive: true });
    await mkdir(join(data, 'ingest-out', 'tx_from_edge'), { recursive: true });
    await mkdir(join(data, 'ingest-out', 'days', 'dt=2026-09-15'), { recursive: true });
    await mkdir(join(data, 'var'), { recursive: true });
    await writeFile(join(data, 'ingest-out', 'swaps_tx', 'part-00000.parquet'), 'x');
    await writeFile(join(data, 'ingest-out', 'tx_from_edge', 'part-00000.parquet'), 'x');
    await writeFile(join(data, 'var', 'peapod.db'), 'x');
  });
  assert.match(out, /HANDED-OVER/);
  assert.match(out, /1 swap parts, 1 identity parts, 1 day partitions/);
  assert.ok(!/no build yet/.test(out));
  assert.ok(!/no swap tape yet/.test(out));
});

test('a volume it cannot inspect still starts the server', async () => {
  // Belt and braces. Whatever else is wrong, the process must come up: the server serves
  // an empty state, and a cycle repairs what it can. Reporting is not worth a crash loop.
  const { out } = await boot(async (/** @type {string} */ data) => {
    await writeFile(join(data, 'ingest-out'), 'not a directory');
  }).catch((err) => ({ out: String(err.stdout ?? '') + String(err.stderr ?? '') }));
  assert.match(out, /HANDED-OVER|could not be inspected/,
    'a malformed volume stopped the container from starting');
});

test('nothing before exec can stop the container starting', async () => {
  // Two ways this has already happened. `ls | wc` under set -eo pipefail exited 2 on an
  // empty directory, silently. And `mkdir -p` on a volume where ingest-out was a file
  // killed the script before any reporting at all. A container that cannot serve an empty
  // state cannot be reached, inspected or repaired — only watched restarting.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(script, 'utf8');
  assert.ok(!/^set -e\b|set -euo/m.test(src),
    'set -e is back: a failed preparation step will refuse to start the server');
  const report = src.slice(src.indexOf('count_parts()'), src.indexOf('if [ "$#"'));
  assert.ok(!/ls .*\| *wc/.test(report), 'counting is back on a pipeline that can fail');
  assert.match(src, /report \|\| echo/, 'reporting can still take the container down');
  assert.match(src, /if ! link_volume; then/, 'the volume setup is fatal again');
  // A failed link is a real degradation and must be said, not swallowed.
  assert.match(src, /will NOT survive a redeploy/);
});


test('it never execs nothing when no command is given', async () => {
  // THE CRASH LOOP. `exec "$@"` with an empty argument list is a silent no-op: the script
  // ends, the container exits 0, and the platform restarts it about once a second having
  // printed one line and no error. Indistinguishable from a crash, and impossible to
  // diagnose from the log, because there is nothing in the log.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(script, 'utf8');
  assert.match(src, /if \[ "\$#" -eq 0 \]/, 'an empty command list still execs nothing');
  assert.match(src, /set -- node .*scripts\/run\.mjs/, 'there is no default command');
  // And it always says what it is about to run. The silence was most of the difficulty.
  assert.match(src, /echo "entrypoint: exec \$\*"/);

  // Run it with no command and check it announces the default rather than exiting quietly.
  const { out } = await boot(undefined, []).catch(
    (/** @type {any} */ err) => ({ out: `${err.stdout ?? ''}${err.stderr ?? ''}` }));
  assert.match(out, /no command given; using the default/);
  assert.match(out, /entrypoint: exec node/);
});
