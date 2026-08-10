#!/bin/bash
# Permanent, append-only archive of the fleet app's log tables.
#
# WHY THIS EXISTS
# bc-fleet deletes log rows older than 120 days (src/log-retention.js). The
# oldest surviving row is 2026-06-28, so the first deletion lands about
# 2026-10-26. Fede's decision (2026-08-10) was: do not touch the fleet app, but
# lose nothing. This script is the "lose nothing" half. It copies log rows out
# to Parquet before the fleet app can delete them, and never deletes anything
# itself.
#
# The most valuable thing in here is booking pace: tour_change_log records every
# time a departure's booking_count moved, which is the only way to reconstruct
# how bookings accumulated in the run-up to a departure. It also carries the
# FareHarbor payloads that per-departure capacity is harvested from.
#
# HOW IT STAYS CORRECT
# Append-only, keyed on the source table's autoincrement id. Each run works out
# the highest id already archived by reading the Parquet itself, then copies
# only rows above it. There is no state file to drift out of sync, and running
# it twice in a row is a no-op. If a part file is ever lost, the next run simply
# re-copies from the new high-water mark; it cannot corrupt what is already there.
#
# ZSTD because this data is extremely repetitive (the same phantom "2.0 -> 5.0"
# logged every 90 seconds by a known fleet bug). Raw it grows about 11 GB a year;
# compressed it is a fraction of that, which is what makes "save everything"
# affordable on a 38 GB disk without touching the fleet app.

set -uo pipefail

SNAP="/var/lib/bc-data/snapshots/fleet.db"
ARCHIVE="/var/lib/bc-data/archive"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $*"; }

if [ ! -f "$SNAP" ]; then
  log "FATAL: no snapshot at $SNAP. Run snapshot-fleet.sh first."
  exit 1
fi

# Tables that carry an INTEGER PRIMARY KEY AUTOINCREMENT, so "new rows" is
# simply "id greater than the highest id we already hold".
ID_TABLES="tour_change_log action_log page_views emails_sent webhook_log admin_notifications bug_reports"

TOTAL_NEW=0

for T in $ID_TABLES; do
  DIR="$ARCHIVE/$T"
  mkdir -p "$DIR"

  # High-water mark straight out of the archive. No state file to go stale.
  if compgen -G "$DIR/*.parquet" > /dev/null; then
    HWM=$(duckdb -noheader -list -c \
      "SELECT COALESCE(MAX(id), 0) FROM read_parquet('$DIR/*.parquet');" 2>/dev/null)
  else
    HWM=0
  fi
  HWM=${HWM:-0}

  OUT="$DIR/part-${STAMP}.parquet"
  N=$(duckdb -noheader -list -c "
    INSTALL sqlite; LOAD sqlite;
    ATTACH '$SNAP' AS f (TYPE SQLITE, READ_ONLY);
    CREATE OR REPLACE TEMP VIEW newrows AS
      SELECT * FROM f.$T WHERE id > $HWM;
    COPY (SELECT * FROM newrows ORDER BY id)
      TO '$OUT' (FORMAT PARQUET, COMPRESSION ZSTD);
    SELECT COUNT(*) FROM newrows;
  " 2>/dev/null | tail -1)
  N=${N:-0}

  # An empty part file is noise: drop it so the archive stays readable and the
  # high-water-mark scan does not slow down over thousands of empty hourly files.
  if [ "$N" = "0" ]; then
    rm -f "$OUT"
  else
    log "  $T: +$N rows (from id > $HWM)"
    TOTAL_NEW=$((TOTAL_NEW + N))
  fi
done

# tour_reminders has no id column, just a one-row-per-availability marker.
# Small and slow growing, so snapshot the whole thing each time into a single
# file rather than trying to diff it.
mkdir -p "$ARCHIVE/tour_reminders"
duckdb -noheader -list -c "
  INSTALL sqlite; LOAD sqlite;
  ATTACH '$SNAP' AS f (TYPE SQLITE, READ_ONLY);
  COPY (SELECT * FROM f.tour_reminders ORDER BY availability_id)
    TO '$ARCHIVE/tour_reminders/current.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
" > /dev/null 2>&1

SIZE=$(du -sh "$ARCHIVE" 2>/dev/null | cut -f1)
log "Archive: +$TOTAL_NEW rows this run, $SIZE on disk total."
