-- peapod: map every Uniswap v4 swap transaction on Robinhood Chain to the account that
-- signed it.
--
-- RAW TABLES ONLY, AND DELIBERATELY SO. Bitquery's normalised layer on this chain priced
-- ETH at $5.06bn a unit, so no vendor's decoded output is consumed here. `transactions.
-- "from"` and `logs.tx_hash` are raw chain facts, not decoder output. Every amount peapod
-- uses is decoded by peapod from the log data and already verified against the chain, so
-- Dune is an index for one field and not a source of arithmetic.
--
-- The filter is the PoolManager address and the Swap topic0, both read off the live
-- deployment rather than computed from an assumed event signature.
--
-- Output is deliberately two columns. Adding block_hash would push the export past the
-- Analyst credit allowance (~430 MB vs ~259 MB); peapod already holds block_hash, tx_index
-- and log_index for every one of these transactions from its own ingest, so the join key
-- is sufficient and the rest is checked locally.

SELECT DISTINCT
    l.tx_hash,
    t."from" AS tx_from
FROM robinhood.logs AS l
JOIN robinhood.transactions AS t
    ON  t.hash         = l.tx_hash
    AND t.block_number = l.block_number
WHERE l.contract_address = 0x8366a39cc670b4001a1121b8f6a443a643e40951
  AND l.topic0          = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f
  AND l.block_number BETWEEN 984356 AND 62441067
  AND t.success
