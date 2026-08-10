#!/bin/bash
# Rebuilds /var/lib/bc-data/warehouse.duckdb from the current snapshot and the
# permanent archive.
#
# Builds into a temp file and swaps atomically, for the same reason the snapshot
# does: DuckDB allows one writer per file, so rebuilding in place would collide
# with any read-only query the app is running. Swapping means a reader either
# gets the whole old warehouse or the whole new one.
#
# Exit codes: 0 ok, 1 missing input, 2 build failed, 3 verification failed.

set -uo pipefail

BASE="/var/lib/bc-data"
SQL="$(dirname "$0")/../sql/build-warehouse.sql"
DEST="$BASE/warehouse.duckdb"
TMP="$BASE/.warehouse.duckdb.tmp"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $*"; }

[ -f "$BASE/snapshots/fleet.db" ] || { log "FATAL: no snapshot"; exit 1; }
[ -f "$SQL" ]                     || { log "FATAL: no $SQL"; exit 1; }

rm -f "$TMP" "$TMP.wal"
log "Building warehouse ..."
START=$(date +%s)

if ! duckdb "$TMP" < "$SQL" > /dev/null; then
  log "FATAL: build failed, keeping the previous warehouse"
  rm -f "$TMP" "$TMP.wal"
  exit 2
fi

# Verify before publishing. An empty or half-built warehouse must never replace
# a working one: every number the tool reports would silently change.
CHECK=$(duckdb "$TMP" -noheader -list -c "
  SELECT (SELECT COUNT(*) FROM bc.departures) || '|' ||
         (SELECT COUNT(*) FROM bc.bookings)   || '|' ||
         (SELECT COUNT(*) FROM bc.products);" 2>/dev/null)
DEPS=$(echo "$CHECK" | cut -d'|' -f1)
BOOKS=$(echo "$CHECK" | cut -d'|' -f2)
PRODS=$(echo "$CHECK" | cut -d'|' -f3)

if [ "${DEPS:-0}" -lt 100 ] || [ "${BOOKS:-0}" -lt 100 ] || [ "${PRODS:-0}" -lt 12 ]; then
  log "FATAL: verification failed (departures=$DEPS bookings=$BOOKS products=$PRODS). Keeping previous."
  rm -f "$TMP" "$TMP.wal"
  exit 3
fi

mv -f "$TMP" "$DEST"
rm -f "$TMP.wal" "$DEST.wal"

ELAPSED=$(( $(date +%s) - START ))
SIZE=$(du -h "$DEST" | cut -f1)
log "OK: $DEPS departures, $BOOKS bookings, ${SIZE}, ${ELAPSED}s -> $DEST"
