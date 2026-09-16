/**
 * The deployed process: serve, and run a cycle on a timer.
 *
 * ONE SERVICE, ONE VOLUME. The API reads the database the cycle writes, so they have to
 * see the same disk. A separate scheduled service on Railway cannot mount another
 * service's volume, so the schedule lives here instead — a timer beside the server rather
 * than a cron job somewhere else.
 *
 * TICKS DO NOT OVERLAP. A cycle takes about a minute and the tick is fifteen, but a slow
 * resolver or a retry storm can outrun that, and two cycles writing the same partitions
 * is exactly the duplicate-event fault the gates exist to catch. If one is still running
 * the tick is skipped and said so, which is what Railway's own cron would have done.
 *
 * A REJECTED BUILD IS NOT A CRASH. The gates roll the transaction back and the store keeps
 * serving the previous build, so exit 2 is logged and the next tick tries again. Only the
 * server dying takes the process down.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const minutes = Number(process.env.PEAPOD_CYCLE_MINUTES || 15);
const runCycles = minutes > 0 && process.env.PEAPOD_CYCLE !== 'off';

const stamp = () => new Date().toISOString().slice(11, 19);
/** @param {string} m */
const say = (m) => console.log(`[${stamp()}] run: ${m}`);

const server = spawn(process.execPath,
  ['--experimental-sqlite', '--no-warnings', 'server.mjs'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
server.on('exit', (code) => {
  say(`server exited (${code}); stopping`);
  process.exit(code ?? 1);
});

/** @type {import('node:child_process').ChildProcess | null} */
let cycle = null;

function tick() {
  if (cycle) {
    say('previous cycle still running; skipping this tick');
    return;
  }
  cycle = spawn('bash', ['scripts/cycle.sh'], { cwd: root, stdio: 'inherit' });
  cycle.on('exit', (code) => {
    cycle = null;
    if (code === 0) say('cycle committed');
    else if (code === 2) say('cycle rejected by the gates; still serving the last good build');
    else if (code === 3) say('another cycle held the lock');
    else say(`cycle failed (${code}); will try again next tick`);
  });
}

if (runCycles) {
  say(`cycling every ${minutes} minutes`);
  // Not on boot: a deploy should start serving immediately, and the first tick lands
  // one interval later rather than competing with startup for the same disk.
  setInterval(tick, minutes * 60_000);
} else {
  say('cycling disabled (PEAPOD_CYCLE=off)');
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    say(`${sig}: stopping`);
    cycle?.kill('SIGTERM');
    server.kill('SIGTERM');
  });
}
