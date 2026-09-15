# Daily trader leaderboard — feasibility, and why it was not built

**Status: investigated, not built.** This is the record of what the data supports, so the
question does not have to be re-opened from scratch.

The brief was a daily top-100 by realized PnL with computed behavioural labels. Three
findings moved it, in order: identity was not in the data we held, most holdings do not
originate on-DEX, and the flow that a strict definition can actually score is a minority of
volume producing very small numbers.

## 1. `sender` is not the trader

The swap tape carried the Uniswap v4 `Swap` event's `sender` — the contract that called
PoolManager — and no transaction hash. On this chain that is a router almost everywhere.

| | |
|---|---|
| Swap legs on tape | 2,397,933 |
| Distinct `sender` values | 1,657 |
| Top 10 senders' share of volume | 75.3% |
| Legs where `sender` is the payer | **0.22%** |
| Payers behind 170 senders, in 1.4% of the tape | **7,423 (43.7x expansion)** |

One router had 2,292 distinct payers behind it in that slice alone. Ranking by `sender`
ranks routers, and any PnL attributed to them is the router's pass-through.

The fix was cheap because nothing was missing from the chain, only from the file:
`ingest_lp_events.py` kept `tx_hash` while the Swap pass discarded it. Re-ingesting kept the
field; all 2,397,933 rows join the original tape on (pool_id, block, log_index) with zero
mismatches across sender, both amounts, sqrt price, liquidity, tick and fee.

An earlier proxy measurement said 30.1% of swaps shared a `(block, sender)` group and was
read as evidence that routing broke attribution. With real transaction hashes, **only 1.5%
of transactions have more than one leg**. The 30% was separate transactions from one router
landing in the same block. Netting legs to trades is still correct; it is a much smaller
correction than the proxy implied.

## 2. Most holdings did not originate on-DEX

Measured on a complete, contiguous window: does an address's cumulative balance in a token
ever go negative when only its on-DEX swaps are replayed? If so, it sold units it never
bought here.

**About 64% of addresses did.** Top-100 by volume ran 63–82% depending on window.

The obvious objection is that a window truncates history, so an address that bought earlier
looks short. Two tests rule that out as the explanation. Across windows from 2h to 16.3h the
figure was flat, with no downward trend. And a **fixed cohort** — the 1,763 addresses active
in the last two hours, with lookback growing so the population is constant and only history
changes — moved 57.7% → 60.1% → 61.8% → 64.0%, *rising* and then plateauing. Truncation bias
would fall.

There is also a domain reason to expect it. These are tokenized equities. Holders acquire
them from Robinhood by issuance, transfer or bridge, not by swapping. Selling without an
on-DEX buy is the normal path here, not an anomaly.

## 3. The definition that survives, and what it leaves

Including those positions would require guessing a cost basis for units whose acquisition is
not in the data. Flagging and including them ranks provenance rather than skill. So the
definition narrowed to completed round-trips only: an address enters on a token it bought
on-DEX and later sold on-DEX, matched first-in-first-out, and realized PnL is computed on the
matched quantity alone. Everything else is out of scope and stated plainly.

**This ranks trading, not holdings.** Someone who bridged in a large position and sold it
made no trading decision that can be scored, and scoring it would reward provenance. That is
the better question, not a workaround.

Measured on a complete 23-hour window of 9,436 addresses:

| Window | Addresses | Qualify | % | Their volume share |
|---|---|---|---|---|
| 2h | 1,763 | 248 | 14.1% | 35.1% |
| 8h | 4,049 | 536 | 13.2% | 36.3% |
| 16h | 7,327 | 1,207 | 16.5% | 49.5% |
| 23h | 9,436 | 1,482 | 15.7% | 49.2% |

Both figures rise with window length and are floors: a buy before the window whose sell falls
inside it is invisible as a pair.

Two numbers matter more than the qualification rate:

- **17.4% of volume is matched round-trip flow** — both legs of matched quantity, the only
  flow this definition scores. Qualifying addresses carry 49% of volume, but most of that is
  their unmatched activity.
- **24.6% of volume is selling with no on-DEX buy**, out of scope by definition and
  consistent with the provenance finding.

## 4. The magnitudes

On the 23-hour window, the top address by realized PnL made **$65** on $18,890 of matched
volume. Tenth place made $25.

That will scale with a longer tape, but it sets the expectation. A daily leaderboard here
ranks round-trip profits of tens of dollars, on a chain whose entire executable depth is
$8.8M. "Top traders by realized PnL" implies something this data does not contain, and no
framing on a method page fixes a headline figure that reads like lunch money.

## 5. What building it would have cost

Not the blocker, but recorded because it was measured.

| | |
|---|---|
| Identity for the full tape (1,815,541 blocks) | ~6.5 h, **$9.08** on Goldsky Edge |
| Full RWA transfer index (~275M events, 202 tokens) | ~8 h, ~174 GB, **$0.14** |

Provider billing is irrelevant at this scale. The real cost of the provenance-aware version
is the balance-reconstruction engine behind 275M events, which does not fit in memory and is
weeks of work, not a script.

## 6. Labels

Four were definable from swap timing and inventory shape: market maker, arbitrageur, bot,
one-shot. **No "smart money" label.** There is no measurable definition that is not simply
"made money recently", which is a ranking and not a behaviour, so it was not shipped rather
than shipped with a vague definition.

## 7. Method notes worth keeping

- **Identity is `tx.from`**, never `Swap.sender`.
- **Legs are not trades.** Net each transaction to one position change per token before
  counting anything; a three-hop route is one decision.
- **Two RPC traps.** ABI words are sign-extended to 256 bits, so decoding an `int128` at its
  declared width turns every negative amount into an enormous positive one. And the public
  node returns `blockTimestamp` as `0x0` on every log while still carrying the field, which
  passes a null check and yields 1970 timestamps.
- **Provider rate limits are per-method.** `eth_getBlockReceipts` was refused at a batch of
  25, `eth_getTransactionByHash` above ~10, `eth_getBlockByNumber` served 25 every 3s
  indefinitely. Generalising a batch size measured on one method to another produced a
  resolver that spent eight minutes backing off and resolved nothing.
- **Measure sustained throughput, not latency.** Twelve rounds at batch 200 reported 317
  sub-requests/s; 120-second trials on the same endpoint gave 88. The short trials were
  shorter than the per-minute budget they were meant to probe.
