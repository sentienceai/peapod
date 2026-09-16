/**
 * The container must come up with an empty volume.
 *
 * It did not. On a fresh deploy there was no database, so the server exited, so the
 * container restarted about once a second, so `railway ssh` could never attach to seed
 * the volume. The container needed data to start and needed to start to receive data.
 *
 * These boot the real server against a directory with nothing in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @param {Record<string,string>} env */
async function boot(env) {
  const port = 3300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath,
    ['--experimental-sqlite', '--no-warnings', 'server.mjs'],
    { cwd: root, env: { ...process.env, ...env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => { setTimeout(r, 100); });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/manifest`);
      return { port, child, log: () => log, res };
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error(`server never came up (exit ${child.exitCode}):\n${log}`);
}

test('the server comes up with an empty volume and stays up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peapod-empty-'));
  const s = await boot({ PEAPOD_DB: join(dir, 'var', 'peapod.db'), PEAPOD_CYCLE: 'off' });
  try {
    // The healthcheck must pass. The service IS healthy; it simply has nothing yet.
    assert.equal(s.res.status, 200, 'the deploy healthcheck would fail on a fresh volume');
    const m = await s.res.json();
    assert.equal(m.build, null);
    assert.equal(m.empty, true);
    assert.match(m.detail, /the first cycle will build one/);

    // Not found is wrong when the answer is "not yet".
    const lb = await fetch(`http://127.0.0.1:${s.port}/api/leaderboard/all/7d`);
    assert.equal(lb.status, 503);

    // The pages still serve, so a visitor sees an empty state rather than a dead host.
    for (const path of ['/traders', '/', '/styles/app.css']) {
      const r = await fetch(`http://127.0.0.1:${s.port}${path}`);
      assert.equal(r.status, 200, `${path} did not serve`);
    }

    // Still alive after all that — this is the crash loop the deploy hit.
    assert.equal(s.child.exitCode, null, `server exited:\n${s.log()}`);
    assert.match(s.log(), /serving an empty state/);
  } finally {
    s.child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('a store that appears after boot is served without a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peapod-late-'));
  const db = join(dir, 'peapod.db');
  const s = await boot({ PEAPOD_DB: db, PEAPOD_CYCLE: 'off' });
  try {
    assert.equal((await s.res.json()).empty, true);
    // The first cycle lands. The server must pick it up rather than needing a bounce,
    // because on Railway a bounce is another crash loop waiting to happen.
    const { copyFile } = await import('node:fs/promises');
    const real = process.env.PEAPOD_DB
      || fileURLToPath(new URL('../var/peapod.db', import.meta.url));
    await copyFile(real, db);
    const after = await fetch(`http://127.0.0.1:${s.port}/api/manifest`).then((r) => r.json());
    assert.ok(after.build, 'the server did not notice the store appearing');
    assert.ok(after.addresses > 1000);
  } finally {
    s.child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('the build needs no lp-terminal checkout, because the registry is vendored', async () => {
  // 76 MB of registry on a volume was a seed step that had to happen before anything
  // could run, and the container could not start to receive it.
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../registry/', import.meta.url));
  for (const want of ['pools.parquet', 'tokens.parquet', 'block_times.parquet',
    'pons-basket.json']) {
    assert.ok(files.includes(want), `registry/${want} is not vendored`);
  }
  const src = await readFile(new URL('../export/build_leaderboard.py', import.meta.url), 'utf8');
  assert.ok(!/from upstream import lp_terminal/.test(src),
    'the leaderboard build still hard-requires an lp-terminal checkout');
  // And nothing in the cycle path reaches into another repository on this machine.
  for (const f of ['export/universe.py', 'ingest/pons_probe.py', 'ingest/eth_usd.py',
    'export/build_leaderboard.py']) {
    const body = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/\/Users\/\w+\/canopy/.test(body), `${f} reads from ~/canopy`);
    assert.ok(!/out\/raw\/pools/.test(body), `${f} reads the full upstream pool registry`);
  }
});
