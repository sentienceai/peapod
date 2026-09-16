/**
 * Every cycle stage, run against a tree that has never held any data.
 *
 * THE GAP THIS FILLS. cycle.test.mjs runs each stage with HOME sandboxed and the RPC
 * pointed at a closed port, which proves a stage needs no second checkout. It runs them
 * inside THIS repository, whose ingest/out/ is full, so every stage that reaches for a
 * directory another stage was supposed to create passes here and fails on a volume. Four
 * cold-start faults shipped behind that gap, one per deploy, each costing a full backfill
 * to discover: an empty concat, a write into a directory only --stage select creates, a
 * frame with no columns because a window held no swaps, and a resolver whose output tree
 * was named by one default while the build read a tree named by another.
 *
 * So these copy the tracked files into a temp directory — the same thing `docker build`
 * does — and run the stages there, against a stub endpoint that answers every call with an
 * empty result.
 *
 * THE STUB HAS TO ANSWER, not refuse. Pointing at a closed port proves less than it looks:
 * a stage that dies on a connection error never reaches the local work that was broken, so
 * three of the four faults above sit behind the network call and the test goes green over
 * them. Empty results are also the honest cold-volume case — a window with nothing in it —
 * and they are what turned a missing column and a missing directory into failures here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const root = fileURLToPath(new URL('../', import.meta.url));
const python = resolve(root, process.env.PEAPOD_PY || '.venv/bin/python');

/** A tree holding exactly what a fresh clone holds: tracked files, no ingest/out, no var. */
async function coldTree() {
  const dir = await mkdtemp(join(tmpdir(), 'peapod-cold-'));
  const { stdout } = await execFile('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 });
  for (const rel of stdout.split('\0').filter(Boolean)) {
    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(join(root, rel)));
  }
  assert.ok(!existsSync(join(dir, 'ingest', 'out')),
    'the fixture is not cold: ingest/out is tracked, so every stage would find its data');
  return dir;
}

/**
 * A chain that exists and holds nothing. Every method answers in the right shape with no
 * content, so a stage gets through its network call and on to the local work under test.
 */
function stubChain() {
  const HEAD = 64_859_069;
  /** @param {string} method @param {any[]} params */
  const answer = (method, params) => {
    if (method === 'eth_blockNumber') return `0x${HEAD.toString(16)}`;
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_call') return `0x${'0'.repeat(64)}`;
    if (method === 'eth_getBlockByNumber') {
      return { number: params?.[0] ?? '0x0', hash: `0x${'1'.repeat(64)}`,
        timestamp: '0x66000000', transactions: [] };
    }
    if (method === 'eth_getTransactionByHash') return null;
    return null;
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const one = (/** @type {any} */ r) =>
        ({ jsonrpc: '2.0', id: r?.id ?? 1, result: answer(r?.method, r?.params?.[0] ? r.params : []) });
      const payload = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      res({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/**
 * A tape with a few rows in it, so the stages downstream of the ingest have a window to
 * work on. Without one, eth/usd correctly skips and the faults in it are never reached.
 * @param {string} dir
 */
async function seedTape(dir) {
  await execFile(python, ['-c', `
import polars as pl, pathlib
out = pathlib.Path("${dir}") / "ingest" / "out"
row = dict(pool_id="0x" + "a" * 64, log_index=0, tx_hash="0x" + "b" * 64,
           amount0="-1000000", amount1="1000000000000000000")
for tape, extra in (("swaps_tx", {"sqrt_price_x96": "79228162514264337593543950336"}),
                    ("pons_swaps", {})):
    d = out / tape
    d.mkdir(parents=True, exist_ok=True)
    pl.DataFrame([{**row, "block": 64_819_081 + i, **extra} for i in range(2)]).write_parquet(
        d / "part-00000.parquet")
`], { cwd: dir });
}

/** @param {string} cwd @param {string[]} argv @param {string} rpc */
function run(cwd, argv, rpc) {
  return new Promise((res) => {
    const child = spawn(python, argv, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        PYTHONPATH: 'ingest:export',
        HOME: cwd,
        GOLDSKY_EDGE_URL: rpc,
        PEAPOD_RPC_URL: rpc,
        PEAPOD_DB: join(cwd, 'var', 'peapod.db'),
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => { clearTimeout(kill); res({ code, out }); });
  });
}

/**
 * The faults that shipped, as the text each one leaves in the log.
 * @type {[RegExp, string][]}
 */
const COLD_FAULTS = [
  [/cannot concat empty list/, 'concatenated an empty directory'],
  [/FileNotFoundError|No such file or directory \(os error 2\)/,
    'wrote into a directory no stage on a cold volume creates'],
  [/ColumnNotFoundError|unable to find column/,
    'built a frame with no columns from an empty result'],
  [/KeyError|ModuleNotFoundError|AttributeError|IndexError|StopIteration/,
    'died on a missing key, module or element'],
];

const CYCLE = await readFile(new URL('../scripts/cycle.sh', import.meta.url), 'utf8');
/** @type {[string, string[]][]} */
const STAGES = [];
for (const line of CYCLE.split('\n')) {
  const m = /^\s*stage\s+"([^"]+)"\s+\$PY\s+([^|#]+)/.exec(line);
  if (m) STAGES.push([m[1], m[2].trim().split(/\s+/)]);
}

/**
 * TWO COLD STATES, BOTH REAL, AND THEY COVER DIFFERENT FAULTS.
 *
 * "empty" is a volume on which nothing has ever run: the directories are not there at all.
 * "seeded" is the same volume one tick later, when the ingest has written a few rows — and
 * it is the only one of the two that gets the stages downstream of the ingest as far as
 * their own work, because a stage with no tape to read correctly skips. Testing only the
 * empty tree hides every fault after the first skip; testing only the seeded one hides the
 * empty concat that started this. Both, then.
 */
for (const state of /** @type {const} */ (['empty', 'seeded'])) {
  test(`no cycle stage assumes a directory another stage created (${state} volume)`, async () => {
    assert.ok(STAGES.length >= 4, `parsed only ${STAGES.length} stages out of cycle.sh`);
    const dir = await coldTree();
    const chain = await stubChain();
    try {
      if (state === 'seeded') await seedTape(dir);
      /** @type {string[]} */
      const reached = [];
      for (const [name, argv] of STAGES) {
        const { out } = await run(dir, argv, chain.url);
        for (const [pattern, what] of COLD_FAULTS) {
          assert.ok(!pattern.test(out),
            `on a ${state} volume, "${name}" ${what}:\n${out.split('\n').slice(-14).join('\n')}`);
        }
        reached.push(`${name}: ${out.trim().split('\n').pop() ?? ''}`);
      }
      if (state === 'seeded') {
        // Not vacuous: the pricing stage must get past its window check, or every fault
        // that lives after it is covered by nothing.
        assert.ok(reached.some((r) => /priced swaps|too short to make a series/.test(r)),
          `eth/usd never reached its own work:\n  ${reached.join('\n  ')}`);
      }
    } finally {
      chain.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('the resolver writes where the fold reads', async () => {
  // The build resolved 87,868 transactions into tx_from and then read tx_from_edge, which
  // did not exist, because the resolver defaulted PEAPOD_SOURCE to "public" and cycle.sh
  // defaulted the same variable to "edge". Both were defensible; nothing made them agree.
  const resolver = await readFile(new URL('../ingest/resolve_senders.py', import.meta.url), 'utf8');
  assert.match(resolver, /^SOURCE = os\.environ\.get\("PEAPOD_SOURCE"\) or ENDPOINT$/m,
    'the resolver names its output tree from something other than the endpoint filling it');

  const fold = await readFile(new URL('../export/universe.py', import.meta.url), 'utf8');
  assert.match(fold, /INGEST\.glob\("tx_from\*"\)/,
    'the fold reads one named sender tree, so a rename strands work already paid for');
});

test('already resolved is already resolved, whatever the tree is called', async () => {
  const resolver = await readFile(new URL('../ingest/resolve_senders.py', import.meta.url), 'utf8');
  const block = /done_blocks: set\[int\] = set\(\)[\s\S]{0,700}?blocks = sorted/.exec(resolver);
  assert.ok(block, 'the resolver no longer computes done_blocks where expected');
  assert.match(block[0], /glob\("out\/tx_from\*"\)/,
    'the resolver only credits work in its own tree, so renaming it re-resolves everything');
});
