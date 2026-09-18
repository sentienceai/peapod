# Deploying peapod

One Railway service, one volume. The cycle writes the database the API reads, so they
have to see the same disk — which is why the schedule is a timer inside the process
rather than a separate cron service. A second Railway service cannot mount this one's
volume.

**An empty volume is the normal first-boot state.** The container comes up, serves an
empty state, and the first cycle fills it. Nothing has to be seeded for it to start.

## What you need to create

**1. A service from this repo.** Railway reads `railway.json` and builds the `Dockerfile`.

**2. A volume mounted at `/data`.** Settings → Volumes → New Volume → mount path `/data`.
Size it **20 GB**. Today's footprint is about 1.1 GB (814 MB tape, 256 MB database), and it
grows with the chain at roughly **150–200 MB a day**: the swap tapes, the resolved senders,
and one small parquet part per day per tape per cycle.

**What it must not do is grow with the CYCLE COUNT.** It did, once, and the volume went from
0.8 GB to 44 GB in two days. `ingest/partitions.py` began life as a one-off migration and was
then wired into the cycle, where it re-partitioned the whole flat tape every fifteen minutes;
`write_days()` never rewrites an existing part, so each run appended a complete fresh copy of
every day it touched — 162 copies of each day, 43 GB of duplicate parquet against 333 MB of
source. Nothing read wrong, because `read_days()` dedups on `(block, log_index)`, which is
exactly why it ran unnoticed. It now keeps a cursor of the source parts it has consumed
(`_partitioned.json` in each day tree) and writes only rows it has not seen, and the cycle
merges a day once it has collected 24 parts.

If you are looking at a volume that already filled this way, `ingest/partitions.py --compact`
merges each day into a single deduped part and deletes the ones it replaces, preserving every
row. It is safe to interrupt — the merged file is renamed into place before any original is
removed — but it must not run while a cycle is mid-build, so stop the schedule first.

**3. Three variables.**

| Variable | Value |
|---|---|
| `GOLDSKY_EDGE_URL` | the full Edge endpoint URL from your `.env` |
| `PEAPOD_CYCLE_MINUTES` | `15` |
| `PORT` | `3000` |

**`PORT` is not optional, and its absence looks like a broken app.** Railway's runtime
injects a `PORT` of its own — 8080 on this service — while the public domain keeps pointing
at whatever port it was created with. The container then comes up healthy, logs `peapod on
http://0.0.0.0:8080`, and every request through the domain answers 502. Pinning `PORT` to
the port the domain targets makes both sides say the same number. If you move the domain to
another port, move this with it.

The URL contains the key, so there is no separate token. Set it as a Railway variable;
`.env` is gitignored and must stay that way.

**`HOST` is not needed.** The image sets `HOST=0.0.0.0`, and the server defaults to it
whenever it detects a container or a platform marker, so you can delete the `HOST`
variable if you added one to unblock a 502. An explicit `HOST` still wins if you set it.

Nothing else. No database add-on, no object storage, and **nothing to seed** — the pool
and token registry (1.3 MB) and the v4 band arithmetic are both vendored in this
repository. `PEAPOD_LP_TERMINAL` is honoured when set but is never required; a cycle that
asks for it is a bug, and `test/cycle.test.mjs` fails if one starts to.

Credentials come from the environment first and `.env` second. There is no `.env` in a
container — it is gitignored, which is the point — so `GOLDSKY_EDGE_URL` must be a Railway
variable.

## Getting the tape onto the volume

The tape is ~814 MB of ingested chain data. You have two options.

### Option A — do nothing (recommended for a first deploy)

Leave the volume empty. A cold start backfills about eight days of blocks and then keeps
up; a container that began at the chain head would take seven days to have a seven-day
leaderboard. It is unattended and takes several hours to catch up, the site serves an
empty state until the first build commits, and it costs roughly $9–20 of Goldsky requests
once.

### Option B — copy the local tape up

Faster if you already have it. Volumes are reachable over **`sftp`** through the service —
`railway ssh` gives an interactive shell but is not a pipe, and **`railway run` executes
locally with Railway's variables injected, not in the container**. That is what broke the
previous version of this file: `railway run mkdir -p /data` ran against your Mac's
read-only root.

```sh
railway link            # pick project comfortable-manifestation, service vivacious-respect
railway volume browse   # opens an sftp session onto /data
```

Then inside that session:

```
put -r /Users/sentientai/peapod/ingest/out  /data/ingest-out
```

Or, if you prefer to stage a single archive:

```sh
tar czf /tmp/tape.tgz -C ~/peapod/ingest out
# upload /tmp/tape.tgz to /data via the sftp session, then:
railway ssh
  cd /data && tar xzf tape.tgz && mv out ingest-out && rm tape.tgz && exit
```

`railway ssh` works once the container is up, which it now is regardless of what is on the
volume. That was the deadlock: the server exited when there was no database, the container
restarted about once a second, and `railway ssh` could never attach — it needed data to
start and needed to start to receive data.

## Checking it

```sh
curl https://<service>.up.railway.app/api/manifest
```

- `{"build": null, "empty": true}` — up, nothing built yet. Expected on a fresh volume.
- `{"build": "20260916T044645Z", ...}` — the timestamp of the last committed cycle.
- **502 from Railway with a deploy that succeeded** — the process is listening on
  loopback, so the proxy cannot reach it. The startup log says what it bound to:
  `peapod on http://0.0.0.0:8080 (HOST is set)` is right;
  `peapod on http://127.0.0.1:8080` is not, and the server warns about it in production.

If `build` stops advancing, the gates are rejecting builds. The logs name which gate, and
the store keeps serving the last good one.

## Refreshing the registry

Only needed when the chain lists a token the vendored registry has never seen. On a
machine with the full lp-terminal checkout:

```sh
PEAPOD_LP_TERMINAL=~/lp-terminal uv run python export/registry.py --refresh
```

Commit the result. `PEAPOD_LP_TERMINAL` also overrides the vendored copy at build time, so
a machine with the full registry reads the real thing.

## What it costs

Hobby is $5/month including $5 of usage: about a minute of CPU every fifteen, idle
otherwise. Goldsky is roughly $21/month, billed separately and driven by how much the chain
trades rather than how often we poll — so 15 minutes costs the same as hourly.

## Pointing a local dev server at it

```sh
PEAPOD_STORE=https://<service>.up.railway.app npm run dev
```

No dataset, no credentials. See `STORE.md`.
