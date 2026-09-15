# Dune export — the independent check on `tx.from`

## What this is for

peapod resolves `tx.from` from an RPC. Dune is a *second, independent* derivation of the
same mapping, so the two can be asserted equal row for row. It is not a substitute source:
if a single row disagrees, the run stops.

Raw tables only. No decoded tables, no Dune arithmetic. See the comment in `tx_from.sql`.

## What you need to do

1. **Subscribe to Analyst** ($65/mo). CSV *download* is Plus-only, but the **API export**
   works on Analyst, which is what the script uses.
2. **Create an API key**: Settings → API keys → New. Copy it.
3. **Create the query**: New query → paste `tx_from.sql` → Save. The query id is the number
   in the URL, `dune.com/queries/<id>`.
4. **Put both in `~/peapod/.env`**:
   ```
   DUNE_API_KEY=<key>
   DUNE_QUERY_ID=<id>
   ```
5. **Run it**: `uv run python ingest/dune/export.py`

The script executes the query, polls until it finishes, pages the results out, and writes
`ingest/out/tx_from_dune/part-*.parquet`. It resumes from whatever it has already written.

## What it will cost

2,357,126 rows at roughly 110 bytes each is about 259 MB. Analyst bills 10 credits per MB
exported, so about **2,593 of the 4,000 monthly credits** — one full export fits, a second
in the same month does not. Query *execution* credits are separate and I have not been able
to confirm their rate, so watch the first run.

A compact variant is available if credits get tight: drop `tx_hash` and select
`l.block_number, t.index` instead, which halves the export to ~130 MB. peapod holds
`tx_index` for every swap, so it can join on `(block_number, tx_index)` instead of the hash.

## Then

`uv run python ingest/dune/compare.py` asserts exact equality against the RPC-resolved set
over their overlap and prints any disagreement. It exits non-zero on the first mismatch.
