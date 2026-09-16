"""Which windows a tape can support, and where detail records come from.

THE BUILD THIS PINS. The first full pipeline run produced a leaderboard for all seven
scopes and not one address payload, and the gate caught it: "1,574 ranked addresses with no
stored payload". Nothing was dropping them. The detail writer was keyed on the literal
string "7d" while the windows themselves were filtered against the length of the tape, so on
a tape younger than seven days the writer simply never ran — every ranked row pointed at an
address the store had never heard of.

The two answers now come from one function, and these are the cases that have to hold.
"""

from __future__ import annotations

import pytest

from build_leaderboard import windows_for

WINDOWS = {"1d": 24, "7d": 168}


def test_a_tape_younger_than_the_widest_window_still_writes_details():
    built, detail = windows_for(48.0, WINDOWS)
    assert list(built) == ["1d"], "a 7d ranking over 48 hours is a 48-hour ranking mislabelled"
    assert detail == "1d", "the window that ranks must be the window that writes payloads"


def test_details_come_from_the_widest_window_when_every_window_builds():
    built, detail = windows_for(200.0, WINDOWS)
    assert set(built) == {"1d", "7d"}
    assert detail == "7d", "details must cover the widest ranking, not the narrowest"


def test_the_detail_window_is_never_narrower_than_a_window_that_ranks():
    # The invariant the gate checks, asserted directly. Every window is a suffix of the
    # tape ending at the same instant, so the widest one built holds a superset of every
    # narrower one's addresses — but only if it IS the widest one built.
    for span in (0.0, 23.9, 24.0, 24.6, 100.0, 167.0, 168.5, 1000.0):
        built, detail = windows_for(span, WINDOWS)
        if not built:
            assert detail is None
            continue
        assert built[detail] == max(built.values()), f"span {span}: details from {detail}"


def test_a_tape_too_short_for_any_window_builds_nothing():
    built, detail = windows_for(1.1, WINDOWS)
    assert built == {} and detail is None


def test_the_half_hour_tolerance_is_kept():
    # A window is built when the tape is within half an hour of it: block timestamps are
    # interpolated and a tape is never exactly 168.0 hours long.
    assert "7d" in windows_for(167.6, WINDOWS)[0]
    assert "7d" not in windows_for(167.4, WINDOWS)[0]


@pytest.mark.parametrize("span,expected", [(48.0, "1d"), (200.0, "7d")])
def test_the_headline_follows_the_same_window_as_the_details(span, expected):
    # The headline figures were keyed on "7d" by the same literal, so a short tape
    # published zeros as the store's summary. One decision, one place.
    assert windows_for(span, WINDOWS)[1] == expected


def test_no_window_name_is_hardcoded_as_a_branch_in_the_build():
    # The regression, named. `name == "7d"` gated the detail writer and the headline while
    # the windows themselves were chosen from the tape's length, and the two disagreed the
    # moment the tape was short. Both now read windows_for().
    import pathlib

    src = (pathlib.Path(__file__).parent / "build_leaderboard.py").read_text()
    for literal in ('name == "7d"', "name == '7d'", 'name == "1d"', "name == '1d'"):
        assert literal not in src, f"{literal} branches on a window name again"
    assert "windows_for(" in src, "the build no longer asks which windows the tape supports"
