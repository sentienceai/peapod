# Deploying peapod

One Railway service, one volume. The cycle writes the database the API reads, so they
have to see the same disk — which is why the schedule is a timer inside the process
rather than a separate cron service. A second Railway service cannot mount this one's
volume.

## What you need to create

**1. A Railway project with one service from this repo.**
Railway reads `railway.json` and builds the `Dockerfile`. No build settings to configure.

**2. A volume, mounted at `/data`.**
Settings → Volumes → New Volume → mount path `/data`.

Size it at **20 GB** to start. Today's footprint is about 1.2 GB (814 MB of tape and
partitions, 256 MB database, 76 MB registry). The transfer index, if it is ever built,
takes it to roughly 40 GB — resize then, not now.

**3. Environment variables.**

| Variable | Value | Why |
|---|---|---|
| `GOLDSKY_EDGE_URL` | the full Edge endpoint URL from `.env` | the only credential the cycle needs |
| `PEAPOD_CYCLE_MINUTES` | `15` | tick interval; `PEAPOD_CYCLE=off` disables it |
| `PEAPOD_DB` | `/data/var/peapod.db` | already set in the Dockerfile; override only to move it |

`GOLDSKY_EDGE_URL` already contains the key, so there is no separate token. **Set it as a
Railway variable, never in the repository** — `.env` is gitignored and must stay that way.

Nothing else is required. There is no database add-on, no Redis, no object storage.

**4. Seed the volume once.** Two things have to be there before the first build:

- **The registry** at `/data/registry/out/` — `raw/pools`, `raw/tokens`,
  `block_times.parquet`. About 76 MB, and it lives in `~/lp-terminal`, outside this repo.
- **The tape** at `/data/ingest-out/` — about 814 MB. Without it the first cycle would
  re-ingest 62M blocks from scratch.

```sh
# from this machine, with the Railway CLI linked to the service
railway run --service peapod bash -c 'mkdir -p /data/registry/out/raw'
tar czf - -C ~/lp-terminal out/raw/pools out/raw/tokens out/block_times.parquet \
  | railway run --service peapod bash -c 'tar xzf - -C /data/registry'
tar czf - -C ~/peapod/ingest out \
  | railway run --service peapod bash -c 'tar xzf - -C /data && mv /data/out /data/ingest-out'
```

If the registry is missing the entrypoint says so on boot and builds fail loudly rather
than silently producing an empty ranking.

## What it costs

Hobby is $5/month including $5 of usage. A cycle is about a minute of CPU every fifteen,
and the service is otherwise idle serving reads. Goldsky is roughly $21/month at this
chain's activity, billed separately — and driven by how much the chain trades, not by how
often we poll, so the 15-minute cadence costs the same as hourly.

## Checking it

```sh
curl https://<your-service>.up.railway.app/api/manifest
```

`build` is the timestamp of the last committed cycle. If it stops advancing, the gates are
rejecting builds — the logs say which gate and the site keeps serving the last good one.

## Pointing a local dev server at it

```sh
PEAPOD_STORE=https://<your-service>.up.railway.app npm run dev
```

No dataset, no credentials. See `STORE.md`.
