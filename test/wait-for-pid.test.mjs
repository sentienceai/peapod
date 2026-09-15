/**
 * Pins the way peapod waits for a long-running ingest to finish.
 *
 * THE BUG THIS PREVENTS. Waiting for a background job by matching its command line —
 * `pgrep -f "python.*resolve_senders"`, or `ps aux | grep -c "[r]esolve_senders"` — also
 * matches any shell whose own command line contains the pattern, which includes the
 * watcher and whatever wrapper spawned it. `pgrep` excludes only its own pid, and the
 * `[r]` bracket trick defeats only grep's own process; neither helps with the wrapper.
 *
 * The failure is silent and asymmetric: the waiter spins forever on a job that already
 * finished, and "still waiting" is indistinguishable from "still working". It cost 13
 * minutes once and nearly blocked a 2.7-hour resolution run from starting.
 *
 * `kill -0 PID` asks the kernel about one specific process and cannot match a watcher, a
 * wrapper, an editor, or a grep of the log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = new URL('../scripts/wait-for-pid.sh', import.meta.url).pathname;

/** @param {string[]} args @returns {{status: number, stdout: string}} */
function run(args) {
  try {
    const stdout = execFileSync(HELPER, args, { encoding: 'utf8', timeout: 20_000 });
    return { status: 0, stdout };
  } catch (error) {
    const e = /** @type {{status: number, stdout: string, stderr: string}} */ (error);
    return { status: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

/** @type {string} */
let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), 'peapod-pid-')); });
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('a pgrep -f pattern matches a watcher that merely carries it', () => {
  // The exact mechanism of the real failure. `pgrep -f` matches against the whole command
  // line, and a regex containing `.*` matches its own literal text: the pattern
  // python.*resolve_senders matches the string "python.*resolve_senders" sitting in a
  // waiting shell's command line. pgrep excludes its own pid and nothing else, so the
  // waiter counts itself as a live match and concludes the job is still running when no
  // such job exists.
  const pattern = `python.*peapod_probe_${process.pid}`;
  // A shell that is neither the job nor pgrep — it merely carries the pattern, as the
  // waiting loop did. Two statements, so bash cannot exec away and drop its command line.
  const holder = spawn('bash', ['-c', `PROBE='${pattern}'; sleep 6`], { stdio: 'ignore' });
  try {
    execFileSync('bash', ['-c', 'sleep 0.4']);
    const matched = execFileSync('bash', ['-c', `pgrep -f "${pattern}" || true`],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.ok(matched.includes(String(holder.pid)),
      'expected a shell carrying the pattern to be matched by it; if this ever fails the '
      + 'hazard is gone and the helper could be simplified');

    // And the pid-based check is not fooled by the same process: it asks about a specific
    // pid, so a watcher carrying the pattern is irrelevant to it.
    const pidfile = join(dir, 'unrelated.pid');
    const dead = execFileSync('bash', ['-c', 'nohup sleep 0 >/dev/null 2>&1 & echo $!'],
      { encoding: 'utf8' }).trim();
    execFileSync('bash', ['-c', 'sleep 0.3']);
    writeFileSync(pidfile, dead);
    const { status, stdout } = run([pidfile, '1']);
    assert.equal(status, 0);
    assert.match(stdout, /is not running/,
      'the pid check reported a finished job as running while a watcher held the pattern');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('waiting by pid returns immediately when the process is gone', () => {
  // Same situation, no spinning: a pid that has exited is simply not running.
  const dead = spawn('sleep', ['0']);
  const pid = dead.pid;
  return new Promise((resolve) => {
    dead.on('exit', () => {
      const pidfile = join(dir, 'dead.pid');
      writeFileSync(pidfile, String(pid));
      const started = Date.now();
      const { status, stdout } = run([pidfile, '1']);
      assert.equal(status, 0);
      assert.match(stdout, /is not running/);
      assert.ok(Date.now() - started < 3000, 'helper spun on a dead pid');
      resolve(undefined);
    });
  });
});

test('waiting by pid blocks until a live process exits, then returns', () => {
  // Started through a shell that exits immediately, so the sleeper is reparented and
  // reaped. A child of this test process would linger as a zombie while execFileSync
  // blocks the event loop, which is a different situation and is covered below.
  const pid = Number(execFileSync(
    'bash', ['-c', 'nohup sleep 3 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' },
  ).trim());
  const pidfile = join(dir, 'live.pid');
  writeFileSync(pidfile, String(pid));
  const started = Date.now();
  const { status, stdout } = run([pidfile, '1']);
  const elapsed = Date.now() - started;
  assert.equal(status, 0);
  assert.match(stdout, /waiting on pid/);
  assert.match(stdout, /exited/);
  assert.ok(elapsed >= 2000, `returned after ${elapsed}ms, before the job could finish`);
  assert.ok(elapsed < 15000, `took ${elapsed}ms for a 3s job`);
});

test('an unreaped child reads as finished, not as still working', () => {
  // kill -0 succeeds on a zombie indefinitely. Without a state check the helper would
  // wait forever on a job that finished the moment its parent stopped reaping.
  const job = spawn('sleep', ['0']);
  return new Promise((resolve) => {
    setTimeout(() => {
      const pidfile = join(dir, 'zombie.pid');
      writeFileSync(pidfile, String(job.pid));
      const started = Date.now();
      const { status } = run([pidfile, '1']);
      assert.equal(status, 0);
      assert.ok(Date.now() - started < 5000, 'helper spun on an exited process');
      resolve(undefined);
    }, 300);
  });
});

test('a missing pidfile is not running, not an error', () => {
  const { status, stdout } = run([join(dir, 'absent.pid'), '1']);
  assert.equal(status, 0);
  assert.match(stdout, /no pidfile/);
});

test('a malformed pidfile fails loudly rather than waiting on nothing', () => {
  const pidfile = join(dir, 'bad.pid');
  writeFileSync(pidfile, 'not-a-pid\n');
  const { status, stdout } = run([pidfile, '1']);
  assert.equal(status, 2, 'a corrupt pidfile must not be treated as "not running"');
  assert.match(stdout, /does not contain a pid/);
});

test('both long-running ingests publish a pidfile', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['swaps_with_tx.py', 'resolve_senders.py']) {
    const source = await readFile(new URL(`../ingest/${name}`, import.meta.url), 'utf8');
    assert.match(source, /claim_pidfile\(PIDFILE\)/, `${name} does not publish its pid`);
    assert.match(source, /atexit\.register\(release\)/, `${name} does not clear its pid on exit`);
  }
});
