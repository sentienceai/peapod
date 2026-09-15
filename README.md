# peapod

Public data site for tokenized equity pools on Robinhood Chain (Arbitrum Orbit L2,
chain 4663). Two tools: a **depth tracker** (real executable ±1% depth per pool, not TVL)
and an **LP calculator** (fees minus impermanent loss versus holding, as a distribution).

Source research lives in `~/lp-terminal` (swap history, depth work, v4 accounting engine)
and `~/canopy` (vanilla-JS frontend, theme layer, dependency-free Node server). Both are
read-only upstreams; peapod copies and ports from them, never edits them.

## Status

The v4 math engine is ported to BigInt with parity tests green, and executable ±1% depth
is computed by walking the real tick liquidity map. The site itself is not built yet.

**The headline number moved: 80.8% → 75.8%**, and two published claims are restated — the
7-day-median count (eight of ten, not nine) and the flat-L "upper bound" (it is neither an
upper nor a lower bound). See [Executable depth](#executable-depth).

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
npm run dev   # serve web/ on :3000, no build, live reload
npm test      # node --test — parity, kernel, findings, render
npm run lint  # tsc --noEmit, JSDoc type check, emits nothing
npm run check # both
```

Data export is offline Python, run against a read-only lp-terminal checkout:

```sh
PEAPOD_LP_TERMINAL=~/lp-terminal python export/executable_depth.py
PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=$PEAPOD_LP_TERMINAL/engine:export \
  python export/test_executable_depth.py
```

It needs `polars` and `numpy`; lp-terminal's `.venv` already has them. peapod does not yet
own a Python environment of its own — that is a loose end, not a decision.

## The data files

`export/build.py` writes four top-level files plus a per-pool directory:

| File | Size | What |
|---|---|---|
| `web/data/meta.json` | 4 KB | provenance, anchors, both depth bases, caveats |
| `web/data/pools.json` | 24 KB | the universe, and which widths each pool can express |
| `web/data/depth.json` | 171 KB | ±1% depth per pool, both bases, 7-day series |
| `web/data/windows.json` | 741 KB | 5,650 calculator windows, columnar, no kernels |
| `web/data/windows/<pool>.json` | 15 KB median | that pool's fee kernels |

Every file carries the same provenance block — deliberate duplication, because these get
downloaded and quoted individually and a depth figure without its anchor will be misread.

**Why windows is split.** Held as one object per window it came to 12.3 MB, and 39% of that
was fee kernels that only ever matter one pool at a time. Rounding and columnar encoding cut
the rest; the kernels moved to per-pool files the calculator fetches when a pool is selected.
This is a deviation from the one-file plan, forced by measurement.

**The calculator precompute.** The IL term is size-independent — position value and the hold
benchmark are both linear in L, and L is linear in notional — so it is computed once per
window. Only fees depend on size, and only through `L/(L + active)`, so each window ships a
bucketed kernel: `fees(N) = Σ G·L/(L+A)` with `L = liquidity_per_dollar · N`. That is the
same functional form as the exact sum, not a curve fitted to it. Bucket width is chosen per
window by measuring the error against the exact sum and narrowing until it is under 0.1%;
each window ships its own certified bound. Two earlier designs were measured against real
segments and discarded: fixed 2× buckets (1.1% worst error) and a sampled size grid with
log-log interpolation (0.37% at 41 points per window, both worse and larger).

The fee model is `fee_attribution.py` — per-swap tick splitting, grossed up for v4 taking
the fee before the price moves, price-taker. `export/test_windows.py` asserts peapod's
faster splitter is segment-for-segment identical to lp-terminal's on randomised maps; only
the lookup differs.

## The site

Two pages, served straight from `web/` with no build step.

**Colour obeys two rules and has no third job.** Hue carries sign — oxblood below a 7-day
median, teal above it. Ink density carries magnitude: the hero band, the in-row depth
rulers and the table rules are one ink at different strengths, so any two marks are
comparable without a legend. Red and green are the default in market interfaces and fail
for red-green colour blindness; these two hold the polarity, separate under protanopia and
deuteranopia, and sit in the ink's tonal register. Signed figures also carry an arrow, so
colour is never the only channel — pinned by a test.

**Type is one family doing structural work.** Archivo, variable in weight and width, with
the width axis used as an instrument: 64% for the wordmark, 80–86% for dense numerals,
100% for prose. Widths are set with `font-stretch`, not `font-variation-settings`, because
the latter is not additive — a rule setting one axis silently resets the other. Source
Serif 4 appears in exactly one role, the method notes and restatements, because those are
the part a reader must weigh rather than scan. Monospace is reserved for hex pool
addresses, where it is semantic.

**The hero is a measurement, not an infographic.** A full-bleed band divided by true share
with the scale drawn beneath it, and under that the sentence that makes it a finding: *47
of 66 pools are narrower than one pixel at this width; the smallest holds $0.02.* That
count is computed from the reader's own band width and recomputed on resize, so it is true
of the screen in front of them. Without it the chart is a generic stacked bar, which is
why it is a tested function rather than markup.

**Provenance is chrome.** Both anchors, the pool count and the gas-subsidy caveat sit in a
strip under the masthead on every page — not in a footer. The subsidy note reads the clock:
after 29 September 2026 it says the subsidy *ended* rather than describing a past date in
the future tense.

**The calculator answers with a distribution.** Histogram first, percentiles under it, the
median window's fee and IL split under that. A requested range is snapped to the nearest
width the pool's tick spacing can express and the interface says so; nothing is
interpolated between widths. The fee estimate's certified error bound is shown rather than
implying exactness.

There is no browser in this environment, so `test/render.test.mjs` runs both pages against
a small DOM stub and asserts what they built from the real data. It is not a visual check
— nothing here lays out or paints — but it holds the decisions above in place. Reverting
any one of them (subsidy out of the strip, headline back into the markup, arrows dropped,
log axis hidden, distribution replaced by a median) fails the suite.

## Executable depth

`export/executable_depth.py` replaces the flat-L depth figure with a walk of the real tick
liquidity map: the ±1% band is split at every initialized tick the price would cross, each
segment valued with the liquidity genuinely active there. Positions whose ranges end inside
the band stop contributing where they end. That is what "executable" means, and it is why
the site can say depth rather than TVL.

The reconstruction is verified, not assumed. Active liquidity at the current tick is the
sum of `liquidityNet` over all ticks at or below it, and every Swap event carries the
pool's real active liquidity, so the map is checked against the chain at the anchor swap
for every pool. **All 66 pools reconstruct exactly.** Any that did not would be excluded
and counted, never silently valued.

| Basis | Top-1 share | Chain-wide depth |
|---|---|---|
| flat-L at tape end (published) | 80.8% | $9.78M |
| flat-L at anchor | 75.2% | $10.17M |
| **executable at anchor** | **75.8%** | **$8.77M** |

Both bases are computed at the same anchor so the comparison isolates the method, and the
published figure is reproduced exactly at the original tape end as a control.

**The anchor.** lp-terminal's ModifyLiquidity ingest finished at block 62,264,735; its swap
ingest ran five hours later, to 62,441,080. Liquidity moved in between, so at the swap
tape's end the tick map is stale — 19 of the top 25 pools fail to reconstruct there. Depth
is therefore taken at each pool's last swap at or before the ModifyLiquidity head. That
costs five hours of freshness and buys a number that can be checked against the chain. Both
timestamps ship with the data.

**The replay is checked at every swap, not just at the anchor.** Building the fee segments
walks the tick map through all 2.4 million swaps in the universe, and every Swap event
carries the pool's real post-swap active liquidity. The reconstruction matched the chain at
**every single swap** — zero mismatches.

**"Nine of ten below their 7-day median" is restated: it is eight of ten, and SPY #1 is at
109%.** lp-terminal took the median liquidity and the median sqrt price over the window and
valued that pair once. peapod samples executable depth every four hours across the seven
days and takes the median of those depths. Executable depth is a function of the whole book,
so a median of the inputs is not the median of the output — they are different statistics,
and peapod publishes the second. On it, eight of the top ten sit below their own median and
the largest pool sits *above* it, at 109%.

Both this and the flat-L correction ship in every data file under `provenance.restatements`,
generated from the computed rows rather than typed in. `test_build_output.py` recomputes both
counts from `depth.json` and fails if the shipped prose disagrees, so neither can quietly
revert.

**The flat-L figure was never an upper bound.** lp-terminal describes it as one, and for
most pools it is: SPY #1 is at 87% of it, GOOGL at 71%. But liquidity can also switch *on*
inside the band, and then real depth is larger — SPCX 104%, TSLA 112%. Across the 58 pools
with a real book the ratio runs p5=69%, p50=100%, p95=116%. It is a point estimate that errs
in both directions, not a ceiling.

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
