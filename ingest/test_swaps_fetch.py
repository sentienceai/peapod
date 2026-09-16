"""The ingest must never skip a range it could not read.

It did, for nine hours. The public RPC rejects a topic list longer than 1,000 values with
-32602 "exceed max topics"; the cycle was sending 7,593. rpc() did not recognise that
message, so it retried six times and returned None — the same value it returned for "too
many logs" — and the caller read a permanent argument error as a sizing problem, shrank
the window to its minimum, and skipped 200 blocks at a time.

These pin the three things that were wrong: the outcomes are distinguishable, the pool
filter is the second axis when the block axis runs out, and a range that cannot be read
stops the run and records a gap instead of advancing the cursor.
"""

from __future__ import annotations

import json

import polars as pl
import pytest

import swaps_with_tx as m


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


def install(monkeypatch, replies):
    """Drive rpc() with a scripted sequence of JSON-RPC bodies."""
    seen = []

    def post(url, json=None, timeout=None):        # noqa: A002
        seen.append(json)
        return FakeResponse(replies[min(len(seen) - 1, len(replies) - 1)])

    monkeypatch.setattr(m.SESSION, "post", post)
    monkeypatch.setattr(m.time, "sleep", lambda *_: None)
    return seen


def error(message, code=-32602):
    return {"jsonrpc": "2.0", "id": 1, "error": {"code": code, "message": message}}


def test_too_many_topics_is_not_a_sizing_problem(monkeypatch):
    # The exact message the public RPC returns. Shrinking the block range never fixes it.
    install(monkeypatch, [error("invalid argument 0: exceed max topics")])
    outcome, _ = m.rpc("eth_getLogs", [{}])
    assert outcome == m.TOO_MANY_TOPICS


def test_too_many_logs_is_a_sizing_problem(monkeypatch):
    for message in ["query returned more than 10000 results",
                    "exceed max results", "response size limit exceeded"]:
        install(monkeypatch, [error(message)])
        outcome, _ = m.rpc("eth_getLogs", [{}])
        assert outcome == m.TOO_MANY_LOGS, message


def test_exhausted_retries_are_a_failure_not_a_refusal(monkeypatch):
    # THE BUG. This used to be indistinguishable from "too many logs", so the caller
    # shrank and then skipped over a range it had simply failed to read.
    install(monkeypatch, [error("some transient upstream thing", code=-32000)])
    outcome, detail = m.rpc("eth_getLogs", [{}], retries=2)
    assert outcome == m.FAILED
    assert "transient" in detail


def test_a_successful_call_returns_its_result(monkeypatch):
    install(monkeypatch, [{"jsonrpc": "2.0", "id": 1, "result": [{"a": 1}]}])
    outcome, value = m.rpc("eth_getLogs", [{}])
    assert outcome == m.OK and value == [{"a": 1}]


def test_the_pool_filter_is_split_into_chunks(monkeypatch):
    seen = install(monkeypatch, [{"jsonrpc": "2.0", "id": 1, "result": [{"x": 1}]}])
    outcome, logs = m.fetch(100, 200, [f"0x{i:04x}" for i in range(2500)], chunk=1000)
    assert outcome == m.OK
    assert len(seen) == 3, "2,500 pool ids should take three calls at 1,000 per call"
    assert [len(c["params"][0]["topics"][1]) for c in seen] == [1000, 1000, 500]
    assert len(logs) == 3, "the chunks' results are unioned"


def test_a_refused_chunk_refuses_the_whole_range(monkeypatch):
    # A union missing one chunk is a hole that looks exactly like data.
    install(monkeypatch, [error("exceed max topics")])
    outcome, _ = m.fetch(100, 200, ["0x01", "0x02"], chunk=1)
    assert outcome == m.TOO_MANY_TOPICS


def test_a_gap_is_recorded_with_the_range_and_the_reason(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "GAPS", tmp_path / "gaps.json")
    m.record_gap(60_482_370, 60_482_569, "unreadable: exceed max topics")
    m.record_gap(60_500_000, 60_500_199, "unreadable: HTTP 429")
    gaps = json.loads((tmp_path / "gaps.json").read_text())
    assert [g["from"] for g in gaps] == [60_482_370, 60_500_000]
    assert gaps[0]["blocks"] == 200
    assert "exceed max topics" in gaps[0]["why"]


def test_stopping_leaves_the_cursor_where_it_was(monkeypatch, tmp_path):
    # The cursor not advancing is the whole point: the next run retries the range rather
    # than building on a tape with a silent hole in it.
    monkeypatch.setattr(m, "GAPS", tmp_path / "gaps.json")
    monkeypatch.setattr(m, "CHECKPOINT", tmp_path / "ckpt.json")
    monkeypatch.setattr(m, "OUT", tmp_path)
    state = {"cursor": 1_000, "part": 0, "rows": 0, "calls": 0}
    m.stop(state, [], 1_000, 1_199, "unreadable: exceed max topics")
    assert json.loads((tmp_path / "ckpt.json").read_text())["cursor"] == 1_000
    assert json.loads((tmp_path / "gaps.json").read_text())[0]["to"] == 1_199


def test_the_skip_path_is_gone():
    # The line that caused this. If it ever comes back, so does the silent data loss.
    source = (m.__file__ and open(m.__file__, encoding="utf8").read()) or ""
    assert "skipping ahead" not in source
    assert "cursor = hi + 1" in source, "the happy path must still advance"


@pytest.mark.parametrize("message,expected", [
    ("exceed max topics", "topics"),
    ("query returned more than 10000 results", "logs"),
    ("execution reverted", "failed"),
])
def test_every_refusal_lands_in_exactly_one_bucket(monkeypatch, message, expected):
    install(monkeypatch, [error(message)])
    outcome, _ = m.rpc("eth_getLogs", [{}], retries=1)
    assert outcome == expected


def test_a_too_wide_block_range_is_a_shrink_condition(monkeypatch):
    # Measured against Edge: 30,000 blocks served, 30,001 refused, from three different
    # base blocks. Independent of how many logs are in the range and of how many pools are
    # asked for. This landed in FAILED, so a 36,000-block window stopped the run and then
    # retried the identical window every fifteen minutes.
    for message in ["getLogs request exceeded max allowed range",
                    "block range 63989123 exceeds maximum of 30000",
                    "requested block range is too large"]:
        install(monkeypatch, [error(message, code=-32012)])
        outcome, _ = m.rpc("eth_getLogs", [{}], retries=1)
        assert outcome == m.TOO_WIDE, message


def test_the_four_refusals_are_all_distinct(monkeypatch):
    cases = {
        "exceed max topics": m.TOO_MANY_TOPICS,
        "getLogs request exceeded max allowed range": m.TOO_WIDE,
        "query returned more than 10000 results": m.TOO_MANY_LOGS,
        "execution reverted": m.FAILED,
    }
    for message, expected in cases.items():
        install(monkeypatch, [error(message)])
        outcome, _ = m.rpc("eth_getLogs", [{}], retries=1)
        assert outcome == expected, f"{message} -> {outcome}"
    assert len(set(cases.values())) == 4, "the buckets must stay distinct"


def test_the_default_window_respects_the_measured_cap():
    # A run that starts above the cap spends its first call learning what a measurement
    # already told us.
    assert m.MAX_WIDTH == 30_000, "the measured Edge limit"
    assert m.MIN_WIDTH < m.MAX_WIDTH


def test_a_refilled_gap_stops_blocking_the_build(monkeypatch, tmp_path):
    # SUBTRACT, NOT MATCH. The gap that prompted this was 36,000 blocks, recorded before
    # the 30,000 cap was known, so no compliant window could ever CONTAIN it — a
    # containment test left it recorded for good and the gate blocked every later build
    # over a hole that had already been refilled.
    monkeypatch.setattr(m, "GAPS", tmp_path / "gaps.json")
    m.record_gap(60_739_528, 60_775_527, "too wide")
    m.clear_gaps(60_739_528, 60_759_527)          # first window
    left = json.loads((tmp_path / "gaps.json").read_text())
    assert len(left) == 1 and left[0]["from"] == 60_759_528 and left[0]["blocks"] == 16_000
    m.clear_gaps(60_759_528, 60_789_526)          # second window covers the rest
    assert not (tmp_path / "gaps.json").exists()


def test_clearing_a_middle_slice_leaves_both_ends(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "GAPS", tmp_path / "gaps.json")
    m.record_gap(1_000, 2_000, "why")
    m.clear_gaps(1_400, 1_600)
    left = json.loads((tmp_path / "gaps.json").read_text())
    assert [(g["from"], g["to"]) for g in left] == [(1_000, 1_399), (1_601, 2_000)]


def test_an_unrelated_range_leaves_a_gap_alone(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "GAPS", tmp_path / "gaps.json")
    m.record_gap(1_000, 2_000, "why")
    m.clear_gaps(5_000, 6_000)
    left = json.loads((tmp_path / "gaps.json").read_text())
    assert [(g["from"], g["to"]) for g in left] == [(1_000, 2_000)]


# --- the window cap is a controller, not a ratchet -------------------------------------

def simulate(refuse, calls=400, start_cap=m.MAX_WIDTH):
    """Replay the cap logic. `refuse(width)` says whether the endpoint refuses that span."""
    cap, width, clean = start_cap, min(20_000, start_cap), 0
    seen = []
    for _ in range(calls):
        width = max(m.MIN_WIDTH, min(width, cap))
        if refuse(width):
            cap = max(m.MIN_WIDTH, min(cap, int(width * m.CAP_DECREASE)))
            clean = 0
            seen.append(("down", cap))
            continue
        clean += 1
        if clean >= m.RECOVER_AFTER and cap < m.MAX_WIDTH:
            cap = min(m.MAX_WIDTH, int(cap * m.CAP_INCREASE))
            clean = 0
            seen.append(("up", cap))
        width = min(cap, int(width * 1.8))
    return cap, seen


def test_the_cap_recovers_once_the_refusals_stop():
    # THE BUG. A dense patch used to lower the ceiling for the rest of the run, so the
    # sparse half of the tape was fetched 200 blocks at a time because of something that
    # happened forty hours earlier.
    budget = {"n": 6}

    def refuse(width):
        if budget["n"] and width > 5_000:
            budget["n"] -= 1
            return True
        return False

    cap, seen = simulate(refuse)
    assert any(d == "up" for d, _ in seen), "the cap never probed upward"
    assert cap == m.MAX_WIDTH, f"the cap settled at {cap:,} instead of recovering"


def test_a_persistently_tight_endpoint_settles_rather_than_collapsing():
    # It must find the real limit and stay near it, not oscillate to the floor.
    cap, _ = simulate(lambda w: w > 8_000)
    assert m.MIN_WIDTH < cap <= 8_000, cap
    assert cap > 3_000, f"the cap collapsed to {cap:,} against a limit of 8,000"


def test_decrease_is_multiplicative_not_one_block():
    # The old rule was cap = width - 1, and once width is clamped to the cap every refusal
    # buys exactly one block: the deployed run was observed going 21,868, 21,867, 21,866.
    # Reaching a real limit of 1,000 that way costs ~29,000 calls. Multiplicative decrease
    # is logarithmic, and the difference is the whole point.
    cap, seen = simulate(lambda w: w > 1_000, calls=40)
    downs = [c for d, c in seen if d == "down"]
    assert cap <= 1_000, f"never converged: {cap:,}"

    steps_multiplicative = len(downs)
    steps_by_one = m.MAX_WIDTH - 1_000
    assert steps_multiplicative < 20, f"took {steps_multiplicative} refusals: {downs}"
    assert steps_multiplicative < steps_by_one / 1_000, (
        f"{steps_multiplicative} refusals against {steps_by_one:,} for width - 1")


def test_the_cap_never_exceeds_the_measured_span_ceiling():
    cap, _ = simulate(lambda w: False, calls=500)
    assert cap == m.MAX_WIDTH == 30_000


def test_both_cap_changes_are_logged_and_distinguishable(capsys, monkeypatch, tmp_path):
    # A ratchet down and a healthy probe are the same shape from outside unless the log
    # says which is which — and a refusal is undiagnosable unless the message is there.
    source = open(m.__file__, encoding="utf8").read()
    assert 'print(f"  cap DOWN' in source
    assert 'print(f"  cap UP' in source
    down = source[source.index('cap DOWN'):source.index('cap DOWN') + 320]
    assert "{value}" in down, "the refusal is logged without the endpoint's message"
    assert "refusal at" in down and "blocks" in down
    up = source[source.index('cap UP'):source.index('cap UP') + 260]
    assert "clean calls" in up and "ceiling" in up, "recovery does not say why or toward what"


def test_every_refusal_path_resets_the_clean_streak():
    # A streak interrupted by a refusal must not count toward probing upward.
    source = open(m.__file__, encoding="utf8").read()
    body = source[source.index("while cursor <= end:"):source.index("clear_gaps(cursor, hi)")]
    assert body.count("clean = 0") >= 4, "a refusal path leaves the streak running"


# --- work must survive a redeploy ------------------------------------------------------

def test_the_ingest_flushes_on_a_timer_not_only_on_a_row_count():
    # PART_ROWS alone meant a run that fetched fewer than 100,000 rows wrote nothing and
    # saved no checkpoint. Eight minutes across 250,000 blocks is about 50,000 rows at
    # this chain's density, so three redeploys in a row lost their entire run and
    # restarted from the same cursor.
    assert m.FLUSH_SECONDS <= 60, f"a {m.FLUSH_SECONDS}s window loses that much on a kill"
    source = open(m.__file__, encoding="utf8").read()
    assert "len(buffer) >= PART_ROWS or time.time() - last_flush >= FLUSH_SECONDS" in source


def test_a_signal_runs_the_registered_stop_work(monkeypatch, tmp_path):
    # A redeploy arrives as SIGTERM. The handler used to release the pidfile and exit,
    # discarding everything buffered.
    called = []
    m._ON_STOP.clear()
    m._ON_STOP.append(lambda sig: called.append(sig))
    path = tmp_path / "pid"
    m.claim_pidfile(path)

    import signal
    handler = signal.getsignal(signal.SIGTERM)
    assert callable(handler)
    try:
        handler(signal.SIGTERM, None)
    except SystemExit:
        pass
    assert called == [signal.SIGTERM], "the stop work did not run"
    assert not path.exists(), "the pidfile was not released"
    m._ON_STOP.clear()


def test_the_ingest_registers_a_flush_for_that_signal():
    source = open(m.__file__, encoding="utf8").read()
    assert '_ON_STOP.append(lambda _sig: flush("stopping"))' in source
    # And the flush records the cursor, or the next run refetches what was just written.
    body = source[source.index("def flush(reason"):source.index("_ON_STOP.append")]
    assert 'state["cursor"] = cursor' in body
    assert "save_checkpoint(state)" in body


def test_a_part_is_written_through_a_temporary_name():
    # A kill during write must not leave a half-written parquet that the reader treats as
    # data. Same discipline the day partitions use.
    source = open(m.__file__, encoding="utf8").read()
    body = source[source.index("def flush(reason"):source.index("_ON_STOP.append")]
    assert ".parquet.tmp" in body and "tmp.rename(part)" in body


def test_the_resolver_flushes_on_a_signal_too():
    src = open(m.__file__.replace("swaps_with_tx", "resolve_senders"), encoding="utf8").read()
    assert "_ON_STOP.append(lambda _sig: flush())" in src
    assert "FLUSH_SECONDS = 30" in src, "a 5-minute window loses 5 minutes to a redeploy"


# --- endpoint and pacing, resolved in one place ----------------------------------------

def test_every_stage_prefers_edge_when_credentials_exist(monkeypatch):
    # swaps_with_tx defaulted to the public node while holding Edge credentials. So did
    # resolve_senders, and that one cost an identity stage 16 hours instead of 1.6.
    import settings
    monkeypatch.delenv("PEAPOD_RPC_URL", raising=False)
    monkeypatch.setattr(settings, "env", lambda **_: {"GOLDSKY_EDGE_URL": "https://edge/x"})
    url, which = settings.endpoint()
    assert which == "edge" and url == "https://edge/x"


def test_it_falls_back_to_the_public_node_without_credentials(monkeypatch):
    import settings
    monkeypatch.delenv("PEAPOD_RPC_URL", raising=False)
    monkeypatch.setattr(settings, "env", lambda **_: {})
    url, which = settings.endpoint()
    assert which == "public" and url == settings.PUBLIC_RPC


def test_an_explicit_url_still_wins(monkeypatch):
    import settings
    monkeypatch.setenv("PEAPOD_RPC_URL", "http://127.0.0.1:9/rpc")
    url, which = settings.endpoint()
    assert url == "http://127.0.0.1:9/rpc" and which == "public"


def test_the_pacing_matches_the_endpoint_it_was_measured_against():
    # Measured over 60-second trials on Edge: 200 every 2s gives 268,872 blocks/hour with
    # nothing refused; the public node's 25 every 3s gives 26,741 on the same endpoint.
    import settings
    assert settings.pacing("edge") == (200, 2.0)
    assert settings.pacing("public") == (25, 3.0)


def test_the_edge_pacing_sits_on_the_documented_budget():
    # 200 every 2s is 100 sub-requests a second, which is exactly 6,000 a minute. Faster
    # is not faster: batch 200 at 0.5s had 90% of its blocks refused.
    import settings
    batch, pace = settings.pacing("edge")
    assert batch / pace * 60 <= 6_000, "the pacing exceeds the per-minute budget"
    assert batch / pace * 60 >= 5_000, "the pacing leaves the budget unused"


def test_pacing_is_still_overridable(monkeypatch):
    import settings
    monkeypatch.setenv("PEAPOD_RPC_BATCH", "50")
    monkeypatch.setenv("PEAPOD_RPC_PACE", "1.5")
    assert settings.pacing("edge") == (50, 1.5)


def test_no_stage_hardcodes_the_public_node_any_more():
    import pathlib
    ingest = pathlib.Path(m.__file__).parent
    for name in ("swaps_with_tx.py", "resolve_senders.py"):
        src = (ingest / name).read_text()
        assert "rpc.mainnet.chain.robinhood.com" not in src, (
            f"{name} names the public node directly instead of asking settings.endpoint()")
        assert "from settings import endpoint" in src


# --- two universes over one ingest ---------------------------------------------
#
# The Pons side used to be fetched by a separate one-shot script that the cycle never ran,
# so a cold volume reached the pricing stage with no Pons tape in existence. These cover
# the parts of sharing one ingest that can go wrong silently: the two tapes writing over
# each other, and a gap in one being cleared by the other.

def test_each_universe_writes_its_own_tape_cursor_and_lock():
    seen = {}
    for which in ("rwa", "pons"):
        m.use_universe(which)
        seen[which] = (m.OUT, m.CHECKPOINT, m.PIDFILE)
    m.use_universe("rwa")
    assert len(set(seen["rwa"]) | set(seen["pons"])) == 6, \
        "the two universes must not share a tape, a cursor or a lock"
    assert seen["pons"][0].name == "pons_swaps"
    assert seen["rwa"][0].name == "swaps_tx"


def test_the_two_pool_sets_are_disjoint_and_neither_is_empty():
    rwa = set(m.select_pools("rwa"))
    pons = set(m.select_pools("pons"))
    assert rwa and pons
    assert not (rwa & pons), "a pool in both universes would be counted twice"


def test_a_gap_is_only_refillable_by_the_universe_that_recorded_it(tmp_path, capsys):
    m.GAPS = tmp_path / "gaps.json"
    m.use_universe("pons")
    m.record_gap(1_000, 2_000, "too wide")
    assert json.loads(m.GAPS.read_text())[0]["universe"] == "pons"

    # The RWA ingest covering the same blocks says nothing about the Pons tape.
    m.use_universe("rwa")
    m.clear_gaps(500, 3_000)
    assert len(json.loads(m.GAPS.read_text())) == 1, \
        "one universe cleared another's gap; block numbers are shared, holes are not"

    m.use_universe("pons")
    m.clear_gaps(500, 3_000)
    assert not m.GAPS.exists()


def test_a_gap_recorded_before_universes_existed_belongs_to_rwa(tmp_path):
    m.GAPS = tmp_path / "gaps.json"
    m.GAPS.write_text(json.dumps([{"from": 10, "to": 20, "blocks": 11, "why": "old"}]))
    m.use_universe("pons")
    m.clear_gaps(0, 100)
    assert json.loads(m.GAPS.read_text()), "Pons refilled a gap the RWA ingest recorded"
    m.use_universe("rwa")
    m.clear_gaps(0, 100)
    assert not m.GAPS.exists()


def test_a_tape_with_no_checkpoint_is_continued_not_overwritten(tmp_path, capsys):
    m.use_universe("pons")
    m.OUT = tmp_path / "pons_swaps"
    m.CHECKPOINT = tmp_path / "pons_swaps.checkpoint.json"
    m.OUT.mkdir()
    pl.DataFrame({"block": [100, 200]}).write_parquet(m.OUT / "part-00000.parquet")
    pl.DataFrame({"block": [300, 450]}).write_parquet(m.OUT / "part-00003.parquet")

    state = m.adopt_orphan_tape({"cursor": None, "part": 0, "rows": 0, "calls": 0})
    assert state["part"] == 4, "part 0 would have been written over the existing tape"
    assert state["cursor"] == 451
    assert m.CHECKPOINT.exists(), "the adoption must survive the process that made it"
    m.use_universe("rwa")


def test_adoption_leaves_a_live_checkpoint_alone(tmp_path):
    m.use_universe("pons")
    m.OUT = tmp_path / "t"
    m.OUT.mkdir()
    pl.DataFrame({"block": [9_000]}).write_parquet(m.OUT / "part-00000.parquet")
    state = m.adopt_orphan_tape({"cursor": 42, "part": 7, "rows": 0, "calls": 0})
    assert (state["cursor"], state["part"]) == (42, 7)
    m.use_universe("rwa")
