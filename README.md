# peapod

Realized profit and loss for every address that has traded on **Robinhood Chain**
(Arbitrum Orbit L2, chain 4663), across both tokenized equities and the Pons memecoin
pools, in one ranking. Searchable by address, whether or not the address ranks.

Over the current seven-day window: **103,920 addresses traded, 30,009 of them closed a
round-trip.** 64.8% of those finished in profit, which sounds healthy until you see the
sizes: the best made $188,639, the median made **$0.84**, and the top 1% took half of
everything won.

## What it measures, and what it does not

**Realized PnL on completed round-trips only.** An address is scored when it bought a
token on-chain and later sold it on-chain; the two are matched first-in-first-out and the
difference is the result. That is the whole definition.

It follows that a great deal is **out of scope, not estimated**:

- **72.7% of volume has no matched round-trip behind it.** Tokens that were bridged in,
  minted, airdropped or transferred from another wallet have no on-chain purchase, so
  selling them produces no cost basis and no number. They are excluded, not guessed at.
- **There is no unrealized PnL.** That would require a balance for every address at every
  block, which needs a full ERC-20 transfer index this does not have (~210M events). Open
  positions are invisible here.
- **No account value, equity, leverage, or liquidation.** Those are perpetuals concepts
  and this is a spot AMM. Where a figure does not exist it is absent from the interface
  rather than shown empty.

Each address carries its own **coverage** figure — what share of its selling had an
on-chain buy behind it — because a record scored over 96% of an address is a different
claim from one scored over 49%. The top-ranked address is at 100%; the one below it, 73%.

The win-rate badge answers one question with a published criterion: an address closed *n*
round-trips and *k* at a profit; 95% of traders with no skill and the same *n* land inside
`0.5 ± 1.96·√(0.25/n)`, so a rate outside that band is one chance produces less than one
time in twenty. It measures the rate, not the profit, and only the selling it can see.
That last limit was tested rather than assumed — see `export/selection_bias.py`.

## Running it

### Against the deployed store — no data, no credentials

```sh
npm install
PEAPOD_STORE=https://<deployed-host> npm run dev
```

The dev server proxies `/api` upstream and serves `web/` locally, so a fresh clone runs
the whole site against real data. Seconds. This is the normal way to work on the
interface. Responses are cached on disk by build id. See [STORE.md](STORE.md).

### Against a local store

```sh
npm run dev
```

Needs `var/peapod.db` (about 256 MB). Seconds if you have one, and `npm run check` needs
it too — the tests query the store rather than fixtures, so they only pass against a real
build.

### Rebuilding from the chain

Needs `GOLDSKY_EDGE_URL` in the environment or `.env`, and about 1 GB of ingested tape in
`ingest/out/`.

```sh
scripts/cycle.sh                      # one incremental cycle
CYCLE_SKIP_INGEST=1 scripts/cycle.sh  # rebuild from what is already on disk
```

An incremental cycle is **about three minutes**; a rebuild from existing tape is **under a
minute**. A cold start with an empty `ingest/out/` backfills roughly eight days of blocks
and takes **several hours** and $9–20 of provider requests, once. No lp-terminal checkout
is required — the pool registry and the v4 band arithmetic are vendored in `registry/` and
`engine/`.

Deploying is [RAILWAY.md](RAILWAY.md).

## The data

**Source.** Swap logs from the v4 `PoolManager`, read over Goldsky Edge and the chain's
public RPC. Two universes: 236 tokenized-equity pools quoting USDG, and 90 Pons pools
quoting ETH or USDG.

**Identity is `tx.from`, never `Swap.sender`.** On Uniswap v4 the `sender` field on a Swap
log is whichever router contract called the PoolManager, so ranking by it ranks routers.
Resolving the real trader means fetching each block and reading the transaction's sender,
which is why identity resolution dominates the cost of a cycle. Legs are also **not
trades**: a three-hop route is one decision, so every transaction is netted to a single
position change per token before anything is counted.

**ETH is priced from this chain.** Half the Pons pools quote in native ETH, so without a
price the two halves cannot share a ranking. The price comes from the deepest ETH/USDG
pool on the chain — chosen by executable ±1% depth, not by trade count, because a thin
pool's spot price is cheap to push. That pool holds 52.6% of all ETH/USDG depth and yields
**72,236 observations over the window, a median four seconds apart**. Every ETH-quoted leg
converts at its own timestamp; repricing a total at one closing rate would credit every
trader with the week's move in ETH, which is not a trading result.

**Verification.** Three independent derivations of the same data:

- The identity mapping was resolved twice, from the public RPC and from Goldsky Edge, and
  compared row for row. **440,211 overlapping transactions, zero disagreements.** (An
  earlier check over 94,368 rows was also exact; the overlap has since grown.)
- The swap tape was resampled against a second provider on `(block, log_index)` identities
  rather than counts — **20 of 20 windows matched**. `ingest/verify_tape.py`.
- The on-chain ETH/USD series agrees with CoinGecko's hourly series to **0.04% at the
  median**, 0.11% at p95.

Ingest enforces record identity rather than deduplicating afterwards: a duplicate is
dropped, a `removed: true` log is rejected outright, and two logs sharing `(block,
log_index)` under different block hashes are both kept and recorded as a conflict.

Ten gates run inside the commit transaction and roll it back if any fails — time moving
backwards, addresses vanishing, an event counted twice, the qualifying count leaving a
0.5×–2× band, a ranked row with no detail record, a flat price series. A build that
completes and is wrong is the failure mode these exist for; a crash was never the hard
case.

## Caveats

- **The window is seven days.** Not all-time. Earlier windows produce very different
  numbers: at 23 hours the best result on the equity side was $65; at seven days it is
  $1,634. Any figure here is a statement about this window.
- **Robinhood Chain ran under a gas subsidy that ends 2026-09-29, after the tape behind
  every figure here.** None of this volume was recorded under real costs, so all of it is
  provisional. This is on every page, not only here.
- **Coverage percentages are shares of this universe**, not of the chain. An address that
  qualifies has closed at least one round-trip *in these pools in this window*; an address
  that does not still gets a page explaining what it did do.
- **RWA looks safer than Pons and is not.** 84.4% of qualifying RWA addresses are in
  profit against 53.4% on Pons, but the best RWA result is $1,634 against $188,639. The
  higher success rate reflects how little is at stake. The interface says so on that tab.
- **Elapsed times are measured from the end of the tape**, not from now, because the data
  is a fixed historical window.

## Architecture

Five stages, sequenced by `scripts/cycle.sh` every fifteen minutes. **Ingest** pulls new
Swap logs from the PoolManager by block range, resuming from a cursor. **Resolve** fetches
each block containing a swap and records the transaction senders — and the block
timestamps, which the logs themselves do not carry on this chain. **Fold** appends both
into UTC-day-partitioned parquet, which is what makes a seven-day query open eight
directories instead of the whole tape. **Build** loads the window, nets each transaction
to one position change per token, walks it in time order matching FIFO, and writes every
ranking scope and every address payload into a single SQLite database in one transaction —
so readers see the previous build until the new one commits, and a failed gate rolls it
back. **Serve** is a dependency-free Node server exposing a small read-only API over that
database, with gzipped payloads handed to the browser exactly as stored.

No build step: `web/` is served as it sits on disk, types are JSDoc checked by
`tsc --noEmit`, and the only runtime dependency is Node 22.

```
npm run check     # tsc --noEmit, then the full suite
npm test          # 135 tests
```

## Layout

| | |
|---|---|
| `ingest/` | chain reads: swaps, identity, block times, ETH/USD, day partitions |
| `export/` | the fold, the scopes, the gates, the store writer |
| `engine/` | v4 concentrated-liquidity math, vendored from lp-terminal |
| `registry/` | pools, tokens, the Pons basket — 1.3 MB, so nothing needs seeding |
| `web/` | the site, served as-is |
| `archive/web/` | the earlier depth tracker and LP calculator, still tested |
| [`STORE.md`](STORE.md) | the query store, the API, and developing without the data |
| [`RAILWAY.md`](RAILWAY.md) | deploying |
