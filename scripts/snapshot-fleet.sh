#!/bin/bash
# Hourly read-only snapshot of the LIVE fleet database.
#
# This is the only script in bc-data that touches bc-fleet at all, so it is the
# one to be careful with. Three rules it must never break:
#
#   1. It only ever READS. `sqlite3 .backup` opens the source read-only and is
#      safe against a running database: it copies page by page and restarts if a
#      writer commits mid-copy. This is the same mechanism bc-fleet's own nightly
#      backup.sh already uses, so it is proven on this exact file.
#   2. It writes the snapshot to a temp name and only moves it into place once
#      the copy succeeded. A half-copied snapshot must never become the file the
#      warehouse reads, or every number in the tool silently goes wrong.
#   3. It never runs at the top of the hour. The fleet's FareHarbor scraper runs
#      at :00 and takes a write lock on fleet.db for the whole run. Snapshotting
#      into that is asking for a lock fight with the live booking app.
#
# Exit codes: 0 ok, 1 source missing, 2 copy failed, 3 verification failed.

set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"   # cron's PATH omits /usr/local/bin

FLEET_DB="/var/www/becopenhagen-fleet/data/fleet.db"
DEST_DIR="/var/lib/bc-data/snapshots"
DEST="$DEST_DIR/fleet.db"
TMP="$DEST_DIR/.fleet.db.tmp"
STAMP="$DEST_DIR/_loaded_at"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $*"; }

if [ ! -f "$FLEET_DB" ]; then
  log "FATAL: fleet database not found at $FLEET_DB"
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -f "$TMP"

# Guard against filling the disk: the snapshot is roughly the size of the source
# and we need room for both the old and the new one during the swap.
NEED_KB=$(( $(du -k "$FLEET_DB" | cut -f1) * 2 ))
FREE_KB=$(df -Pk "$DEST_DIR" | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -lt "$NEED_KB" ]; then
  log "FATAL: need ${NEED_KB}KB free, have ${FREE_KB}KB. Refusing to snapshot."
  exit 2
fi

log "Snapshotting $FLEET_DB ..."
START=$(date +%s)

# .backup is the whole point: a consistent copy of a live WAL database.
# Reading the file with cp would catch it mid-write and produce a corrupt copy.
# busy_timeout lets us ride out a checkpoint instead of failing instantly.
# `.backup` is a CLI dot-command, not SQL, so it cannot share an argument with a
# PRAGMA. -cmd runs the pragma first, then the dot-command is the final argument.
if ! sqlite3 "file:${FLEET_DB}?mode=ro" \
      -cmd "PRAGMA busy_timeout = 30000" \
      ".backup '$TMP'" > /dev/null; then
  log "FATAL: .backup failed"
  rm -f "$TMP" "$TMP-wal" "$TMP-shm"
  exit 2
fi

# The copy inherits WAL journal mode from the source, which means any reader has
# to be able to create a -shm sidecar next to it. DuckDB attaching READ_ONLY
# cannot, so a WAL-mode snapshot is fragile to read and leaves stray sidecars
# around. Convert our own copy (never the source) to a single self-contained
# file. This is a write to the snapshot, not to fleet.db.
sqlite3 "$TMP" "PRAGMA journal_mode = DELETE;" > /dev/null
rm -f "$TMP-wal" "$TMP-shm"

# Verify before publishing. A snapshot that does not open, or that lost a table,
# must not replace a good one.
if ! sqlite3 "file:${TMP}?mode=ro" "PRAGMA quick_check;" | grep -q '^ok$'; then
  log "FATAL: snapshot failed integrity check, keeping the previous one"
  rm -f "$TMP"
  exit 3
fi

TABLES=$(sqlite3 "file:${TMP}?mode=ro" \
  "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
if [ "${TABLES:-0}" -lt 25 ]; then
  log "FATAL: snapshot has only ${TABLES} tables, expected at least 25. Keeping the previous one."
  rm -f "$TMP"
  exit 3
fi

# Atomic swap. mv within one filesystem is atomic, so a reader either sees the
# whole old snapshot or the whole new one, never a partial file.
mv -f "$TMP" "$DEST"
rm -f "$DEST-wal" "$DEST-shm"   # stale sidecars from any previous WAL-mode snapshot
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STAMP"

ELAPSED=$(( $(date +%s) - START ))
SIZE=$(du -h "$DEST" | cut -f1)
log "OK: ${SIZE}, ${TABLES} tables, ${ELAPSED}s -> $DEST"
