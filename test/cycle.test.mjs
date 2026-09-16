/**
 * The cycle must run with no lp-terminal checkout.
 *
 * I claimed this once on the strength of testing the BUILD stage alone. The cycle runs
 * four ingest stages before the build, and the first of them read lp-terminal's own swap
 * tape for its pool list and block range — so every tick in the container died on
 * "PEAPOD_LP_TERMINAL is not set" and the manifest sat at null for an hour.
 *
 * The lesson is the test, not the fix: a stage is only proven container-clean by running
 * it the way a container does. Each one below runs as a subprocess with the variable
 * unset, HOME pointed at an empty directory so ~/lp-terminal cannot be found, and the RPC
 * aimed at a closed port. Reaching a connection error means the stage resolved everything
 * it needs locally and got as far as the network, which is exactly the claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PEAPOD_PY || '.venv/bin/python';

/**
 * Stages the 15-minute cycle runs, in order, before the build.
 * @type {[string, string[]][]}
 */
const STAGES = [
  ['swaps: rwa', ['ingest/swaps_with_tx.py', '--from', '64000000', '--to', '64000001']],
  ['identity', ['ingest/resolve_senders.py', '--max-hours', '0.001']],
  ['partitions', ['ingest/partitions.py', '--only', 'swaps_tx']],
  ['eth/usd', ['ingest/eth_usd.py', '--stage', 'series']],
];

/** @param {string[]} argv @param {Record<string,string>} env */
function run(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(python, argv, {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env, PYTHONPATH: 'ingest:export' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // The failure this guards against happens at startup, before any network call, so
    // a few seconds is enough to tell "resolved everything locally" from "died looking
    // for another checkout". Waiting for the RPC retries to exhaust took 110 seconds.
    const kill = setTimeout(() => child.kill('SIGKILL'), 6_000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

test('no cycle stage reaches for an lp-terminal checkout', async () => {
  // Static first, because it names the offending line rather than a symptom.
  const files = ['ingest/swaps_with_tx.py', 'ingest/resolve_senders.py',
    'ingest/partitions.py', 'ingest/eth_usd.py', 'export/build_leaderboard.py',
    'export/universe.py', 'export/registry.py'];
  /** @type {string[]} */
  const offenders = [];
  for (const f of files) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\blp_terminal\(\)/.test(line)) offenders.push(`${f}:${i + 1} calls lp_terminal()`);
      // A bare index throws KeyError where a .get() would fall back.
      if (/os\.environ\["PEAPOD_LP_TERMINAL"\]/.test(line)) {
        offenders.push(`${f}:${i + 1} indexes PEAPOD_LP_TERMINAL`);
      }
    });
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

test('every cycle stage runs to the network with no checkout and no .env', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'peapod-nolp-'));
  try {
    for (const [name, argv] of STAGES) {
      const { out } = await run(argv, {
        HOME: sandbox,
        // No .env is readable in a container; the platform sets these as variables.
        GOLDSKY_EDGE_URL: 'http://127.0.0.1:9/edge',
        PEAPOD_RPC_URL: 'http://127.0.0.1:9/rpc',
        PEAPOD_DB: join(sandbox, 'peapod.db'),
      });
      assert.ok(!/PEAPOD_LP_TERMINAL is not set/.test(out),
        `${name} still requires an lp-terminal checkout:\n${out.slice(0, 400)}`);
      assert.ok(!/No such file or directory.*lp-terminal/.test(out),
        `${name} still reads from ~/lp-terminal:\n${out.slice(0, 400)}`);
      assert.ok(!/KeyError|ModuleNotFoundError/.test(out),
        `${name} failed on a missing key or module:\n${out.slice(0, 400)}`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('the v4 math is vendored, not reached for', async () => {
  // It is only needed to choose the ETH/USD reference pool, but it was imported for every
  // stage — so `--stage series`, which never touches it, died on the import.
  const src = await readFile(new URL('../engine/liquidity_math.py', import.meta.url), 'utf8');
  assert.match(src, /VENDORED FROM lp-terminal/);
  assert.match(src, /getSqrtPriceAtTick/);
  const eth = await readFile(new URL('../ingest/eth_usd.py', import.meta.url), 'utf8');
  assert.match(eth, /if args\.stage == "select":/,
    'the band arithmetic is still imported for stages that do not use it');
});

test('credentials come from the environment, not only from a gitignored file', async () => {
  // .env is gitignored, which is the point, so it does not exist in a container. A stage
  // that read only the file would fail on a missing key rather than a missing file.
  const settings = await readFile(new URL('../ingest/settings.py', import.meta.url), 'utf8');
  assert.match(settings, /values\.update\(\{k: v for k, v in os\.environ\.items\(\)/);
  for (const f of ['eth_usd', 'balance_spike', 'pons_probe', 'token_decimals',
    'transfer_cardinality']) {
    const src = await readFile(new URL(`../ingest/${f}.py`, import.meta.url), 'utf8');
    assert.match(src, /from settings import env/, `${f} still defines its own env()`);
    assert.ok(!/def env\(\)/.test(src), `${f} still has a local .env-only reader`);
  }
});
