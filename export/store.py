"""The query store: one SQLite database, built for a million addresses.

WHY THIS REPLACES FILE-PER-ADDRESS. 103,920 JSON files is 580 MB and five times
Cloudflare Pages' 20,000-file deployment cap. The transfer index implies roughly a
million addresses, which would be 5.6 GB across a million files. That model does not
scale and is already broken, so this is sized for the million rather than for today.

GZIPPED PAYLOADS, SERVED AS-IS. Each detail payload is stored gzip-compressed and handed
to the browser with Content-Encoding: gzip, so the server never decompresses anything: no
CPU per request, and about a fifth of the bytes over the wire. JSON of this shape
compresses six to eight fold.

SUMMARY COLUMNS BESIDE THE BLOB. Search and filters need to sort and range-scan without
opening a million blobs, so the handful of fields the interface actually queries are
ordinary indexed columns. Everything else lives in the blob, where it costs nothing until
someone asks for it.

ONE TRANSACTION IS THE FLIP. SQLite in WAL mode gives readers a consistent snapshot until
a writer commits, so a whole cycle -- leaderboards, addresses, the build id -- goes in as
one transaction. A crash halfway rolls back and the site keeps serving the previous build.
There is no partial state to serve and no separate manifest to get out of step, because the
build id is written inside the same commit as the data it describes.

INCREMENTAL BY CONSTRUCTION. Rows are upserted, so a 15-minute cycle rewrites the ~3% of
addresses that changed instead of republishing the set. Nothing is uploaded per address at
all: the database lives on the volume the API reads from.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leaderboard (
  scope TEXT NOT NULL,
  window TEXT NOT NULL,
  rows INTEGER NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (scope, window)
);
CREATE TABLE IF NOT EXISTS address (
  addr TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  realized REAL NOT NULL,
  round_trips INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  matched_volume REAL NOT NULL,
  total_volume REAL NOT NULL,
  last_ts INTEGER,
  universes TEXT NOT NULL,
  build TEXT NOT NULL,
  payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS address_realized ON address(realized DESC);
CREATE INDEX IF NOT EXISTS address_build ON address(build);
CREATE TABLE IF NOT EXISTS asset (
  symbol TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  price REAL,
  volume REAL NOT NULL,
  volume24h REAL NOT NULL,
  traders INTEGER NOT NULL,
  build TEXT NOT NULL,
  payload BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_list (
  id TEXT PRIMARY KEY,
  payload BLOB NOT NULL
);
"""



def pack(obj) -> bytes:
    """Gzip at level 6: the knee of the curve for JSON this shape, and fast enough to
    run a million times in a cycle."""
    return gzip.compress(json.dumps(obj, separators=(",", ":"), allow_nan=False).encode(),
                         compresslevel=6, mtime=0)


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)

    def begin(self) -> None:
        self.db.execute("BEGIN IMMEDIATE")

    def commit(self) -> None:
        self.db.execute("COMMIT")

    def rollback(self) -> None:
        self.db.execute("ROLLBACK")

    def put_leaderboard(self, scope: str, window: str, payload: dict) -> None:
        self.db.execute(
            "INSERT INTO leaderboard(scope, window, rows, payload) VALUES (?,?,?,?) "
            "ON CONFLICT(scope, window) DO UPDATE SET rows=excluded.rows, "
            "payload=excluded.payload",
            (scope, window, len(payload.get("rows", [])), pack(payload)))

    def put_addresses(self, records, build: str, batch: int = 2000) -> int:
        """Upsert address detail. A cycle touches roughly 3% of them; the rest are untouched
        rather than rewritten, which is what makes a 15-minute cadence cheap."""
        sql = ("INSERT INTO address(addr, status, realized, round_trips, win_rate, "
               "matched_volume, total_volume, last_ts, universes, build, payload) "
               "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
               "ON CONFLICT(addr) DO UPDATE SET status=excluded.status, "
               "realized=excluded.realized, round_trips=excluded.round_trips, "
               "win_rate=excluded.win_rate, matched_volume=excluded.matched_volume, "
               "total_volume=excluded.total_volume, last_ts=excluded.last_ts, "
               "universes=excluded.universes, build=excluded.build, "
               "payload=excluded.payload")
        n, buf = 0, []
        for payload in records:
            s = payload["summary"]
            buf.append((payload["address"], payload["status"], s["realized"],
                        s["round_trips"], s["win_rate"], s["matched_volume"],
                        s["total_volume"], s.get("last_ts"),
                        ",".join(payload.get("universes", [])), build, pack(payload)))
            if len(buf) >= batch:
                self.db.executemany(sql, buf)
                n += len(buf)
                buf = []
        if buf:
            self.db.executemany(sql, buf)
            n += len(buf)
        return n

    def put_assets(self, assets, build: str) -> int:
        """Upsert one payload per asset, and the whole listing as a second payload.

        THE LISTING IS STORED BUILT, NOT ASSEMBLED PER REQUEST. /api/assets is the first
        thing the asset page asks for, and composing it would mean opening and
        decompressing every per-asset blob on every cold request -- the one thing the
        gzip-as-stored convention exists to avoid. It costs a few kilobytes to hold twice.

        Written in the caller's transaction, like everything else in a cycle: a reader must
        never see this build's assets beside the previous build's leaderboard.

        Rows are upserted and never deleted, as addresses are, so a symbol that stopped
        trading keeps its last payload while falling out of the listing. `build` is what
        tells those two apart afterwards. `price` is nullable because an asset whose every
        trade in the window was dust has no price anyone paid.
        """
        sql = ("INSERT INTO asset(symbol, kind, price, volume, volume24h, traders, build, "
               "payload) VALUES (?,?,?,?,?,?,?,?) "
               "ON CONFLICT(symbol) DO UPDATE SET kind=excluded.kind, price=excluded.price, "
               "volume=excluded.volume, volume24h=excluded.volume24h, "
               "traders=excluded.traders, build=excluded.build, payload=excluded.payload")
        rows, listing = [], []
        for payload in assets:
            a = payload["asset"]
            rows.append((a["symbol"], a["kind"], a["price"], a["volume"], a["volume24h"],
                         a["traders"], build, pack(payload)))
            listing.append(a)
        self.db.executemany(sql, rows)
        self.db.execute(
            "INSERT INTO asset_list(id, payload) VALUES ('assets', ?) "
            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", (pack(listing),))
        return len(rows)

    def set_meta(self, **kv) -> None:
        self.db.executemany(
            "INSERT INTO meta(key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [(k, json.dumps(v)) for k, v in kv.items()])

    def get_meta(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def counts(self) -> dict:
        one = self.db.execute(
            "SELECT COUNT(*), SUM(round_trips > 0), SUM(LENGTH(payload)) FROM address"
        ).fetchone()
        lb = self.db.execute("SELECT COUNT(*) FROM leaderboard").fetchone()[0]
        assets = self.db.execute("SELECT COUNT(*) FROM asset").fetchone()[0]
        return {"addresses": one[0] or 0, "qualifying": one[1] or 0,
                "payload_bytes": one[2] or 0, "leaderboards": lb, "assets": assets}

    def optimize(self) -> None:
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.execute("PRAGMA optimize")


def new_build_id() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
