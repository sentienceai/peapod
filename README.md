# peapod

Public data site for tokenized equity pools on Robinhood Chain (Arbitrum Orbit L2,
chain 4663). Two tools: a **depth tracker** (real executable ±1% depth per pool, not TVL)
and an **LP calculator** (fees minus impermanent loss versus holding, as a distribution).

Source research lives in `~/lp-terminal` (swap history, depth work, v4 accounting engine)
and `~/canopy` (vanilla-JS frontend, theme layer, dependency-free Node server). Both are
read-only upstreams; peapod copies and ports from them, never edits them.

## Status

Step 1 of the build order is complete: the v4 math engine is ported to BigInt and its
parity tests are green. Nothing else is built yet.

## Constraints

**No build step.** No bundler, no transpiler, no framework. `web/` is served as-is. The
reason is not minimalism: the credibility of the calculator rests on the math engine being
parity-validated against Uniswap v4-core, and with no build step the file the parity tests
prove correct is byte-for-byte the file the browser loads. Do not introduce a transform
between the two.

**Types without a build.** Types are JSDoc annotations in the `.js` sources, checked by
`npm run lint` (`tsc --noEmit`, with `checkJs` set in `tsconfig.json`). It never emits and
nothing it produces is served. TypeScript is a devDependency; the site itself has no
runtime dependencies, and any third-party browser library is vendored as a pinned file.

## Commands

```sh
npm test      # node --test — the parity gate
npm run lint  # tsc --noEmit, JSDoc type check, emits nothing
npm run check # both
```

## The math engine

`web/engine/liquidity-math.js` is a 1:1 BigInt port of lp-terminal's
`engine/liquidity_math.py`, itself a 1:1 port of v4-core @ v4.0.0 — `TickMath`,
`SqrtPriceMath`, and the three-branch split of `Pool.modifyLiquidity`.

Every value is an exact integer. There is no `Number` arithmetic in that file, and there
must not be. v4 rounds *against* the LP when liquidity is added and *toward* the pool when
it is removed; a float port drifts by a wei per call and compounds across a backtest.

### What the tests prove

17 tests over three ground-truth fixtures, all generated from canonical v4-core:

| Fixture | Cases | Pins |
|---|---|---|
| `positions.json` | 20 | `modifyLiquidityDelta` on real Robinhood Chain positions |
| `tick-sweep.json` | 477 | `getSqrtPriceAtTick` across the full tick domain |
| `delta-sweep.json` | 280 | `getAmount0Delta` / `getAmount1Delta` over a price × liquidity grid |
| `boundary-sweep.json` | 216 | the three-branch split at every range boundary |

`positions.json` is byte-identical to the fixture lp-terminal's
`contracts/test/LiquidityParity.t.sol` asserts against v4-core, so green here plus green
`forge test` there means JS == Python == v4-core on the same 20 real positions.

### Why the sweeps exist

The suite was mutation-tested: eleven deliberate defects were introduced one at a time to
find what the tests would miss. `positions.json` alone caught only six of them. It cannot
pin `getSqrtPriceAtTick` — its positions are mostly full-range, so the bounds are MIN/MAX
tick, and `sqrtPriceX96` comes straight from the event rather than from a tick. A corrupted
per-bit multiplier that changes the sqrt price at 6,898 of 18,295 ticks passed all 20
fixtures. Nor does it contain a case where the price sits strictly inside a tick that
equals a range bound, so a `<` → `<=` slip in the branch survived it too.

The three sweeps close those holes. The battery now catches every mutation except a 1-ulp
change to a tick multiplier, which was verified to be unobservable — identical output at
all 136,504 sampled ticks, because the `>> 32` truncation absorbs it. That is not a defect
the tests miss; it is not a defect.

Regenerating fixtures: see `tools/parity/README.md`.

## Caveat that travels with every number on this site

Robinhood Chain ran under a gas subsidy that ends **2026-09-29**. The current tape ends
2026-09-14, so every volume and activity figure predates the real cost regime. Results are
provisional and the study re-runs in October. The tape date and this caveat must be visible
on the site, not buried in a method page.
