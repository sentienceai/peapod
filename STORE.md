# The query store

One SQLite database, built by `export/build_leaderboard.py`, read by `web-api.mjs`.

## Why it replaced files

103,920 JSON files was 580 MB and five times Cloudflare Pages' 20,000-file deployment
cap. The transfer index implies roughly a million addresses — 5.6 GB across a million
files. This is sized for the million, not for today: **256 MB** holds 103,920 addresses
with 184 MB of gzipped payload, so a million projects to about 2.5 GB on a volume.

Nothing is uploaded per address. The database lives on the volume the API reads from, and
a cycle upserts the ~3% of rows that changed.

## The atomic flip

WAL mode gives readers a consistent snapshot until a writer commits, so a whole cycle —
every leaderboard scope, every changed address, and the build id — goes in as **one
transaction**. A crash halfway rolls back and the site keeps serving the previous build.
There is no separate manifest to fall out of step, because the build id is written inside
the same commit as the data it describes.

## The API is the contract

Everything the page reads goes through `/api`, so where the bytes live stops mattering to
the front end.

| Route | Returns |
|---|---|
| `GET /api/manifest` | build id, built_at, counts, scopes, windows |
| `GET /api/leaderboard/index` | the scope and window index |
| `GET /api/leaderboard/:scope/:window` | one ranking |
| `GET /api/address/:addr` | one address's detail, 404 if it never traded |
| `GET /api/search?q=0x…` | prefix matches |

Payloads are stored gzipped and served with `Content-Encoding: gzip` **untouched** — the
server never decompresses, so a request costs one indexed lookup.

## Running it without the data

```sh
PEAPOD_STORE=https://<deployed-host> npm run dev
```

The dev server proxies `/api` upstream and serves `web/` locally, so a clone runs against
real data with no dataset at all. 256 MB is not something to hand a collaborator, and a
stale copy is worse than none.

- **Read-only.** There is no write route to forward. The proxy sends the path and query
  and nothing else: no headers, no credentials, no cookies.
- **Cached on disk**, keyed by the upstream build id, so iterating does not hammer
  production and invalidates when the deployment moves rather than going stale.
- **Re-compressed**, so a proxied route behaves exactly like a local one.
- The footer names the build, so a bug report can say which one it saw.

With neither a store nor an upstream the server exits and names both options rather than
serving an empty site that looks broken.

**Two different jobs.** The site is developable by anyone with the command above.
*Rebuilding the data* still needs the raw tape and Goldsky credentials.

## Building one

```sh
PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest \
  uv run python export/build_leaderboard.py --source edge
```

`PEAPOD_DB` overrides the location (default `var/peapod.db`).
