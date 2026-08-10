#!/bin/bash
# Refreshes the FRESHNESS columns on catalog.sources after every warehouse build.
#
# Touches only last_loaded_at, prev_row_count, last_row_count and
# max_date_in_data. Never description, grain, gotchas or retrieval_instructions:
# those are written by people (or reviewed by them) and an automated job must
# not be able to overwrite them. That separation is why the catalog lives in its
# own file rather than in the hourly-rebuilt warehouse.
#
# prev_row_count is carried from the previous last_row_count BEFORE the new one
# is written, which is what makes the phase 5 volume-drop alert possible: a
# source that refreshes on schedule with garbage in it is worse than one that is
# visibly stale.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

WH="/var/lib/bc-data/warehouse.duckdb"
CAT="/var/lib/bc-data/catalog_store.duckdb"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $*"; }
command -v duckdb > /dev/null || { log "FATAL: duckdb not on PATH"; exit 1; }
[ -f "$WH" ]  || { log "FATAL: no warehouse"; exit 1; }
[ -f "$CAT" ] || { log "FATAL: no catalog"; exit 1; }

# Row counts and the newest business date per source, straight from the
# warehouse that was just built.
STATS=$(duckdb "$WH" -noheader -list -c "
  SELECT 'bc.departures'           || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.departures
  UNION ALL SELECT 'bc.departures_recovered' || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.departures_recovered
  UNION ALL SELECT 'bc.bookings'            || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.bookings
  UNION ALL SELECT 'bc.booking_pace'        || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.booking_pace
  UNION ALL SELECT 'bc.rental_slots'        || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(pickup_date)::VARCHAR,'')    FROM bc.rental_slots
  UNION ALL SELECT 'bc.guide_hours'         || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.guide_hours
  UNION ALL SELECT 'bc.guide_reviews'       || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(review_date)::VARCHAR,'')    FROM bc.guide_reviews
  UNION ALL SELECT 'bc.fleet_bikes'         || chr(9) || COUNT(*) || chr(9) || ''                                        FROM bc.fleet_bikes
  UNION ALL SELECT 'bc.repairs'             || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(opened_date)::VARCHAR,'')    FROM bc.repairs
  UNION ALL SELECT 'bc.products'            || chr(9) || COUNT(*) || chr(9) || ''                                        FROM bc.products
  UNION ALL SELECT 'bc.departure_bikes'     || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(departure_date)::VARCHAR,'') FROM bc.departure_bikes
  UNION ALL SELECT 'bc.departure_capacity'  || chr(9) || COUNT(*) || chr(9) || ''                                        FROM bc.departure_capacity
  UNION ALL SELECT 'bc.team'                || chr(9) || COUNT(*) || chr(9) || ''                                        FROM bc.team
  UNION ALL SELECT 'bc.data_freshness'      || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(latest_departure)::VARCHAR,'') FROM bc.data_freshness
  UNION ALL SELECT 'bc.fleet_snapshot'      || chr(9) || COUNT(*) || chr(9) || COALESCE(MAX(latest_departure)::VARCHAR,'') FROM bc.data_freshness;
") || { log "FATAL: could not read warehouse stats"; exit 2; }

LOADED=$(duckdb "$WH" -noheader -list -c "SELECT loaded_at FROM bc.data_freshness;")

SQL=""
while IFS=$'\t' read -r KEY N MAXD; do
  [ -z "${KEY:-}" ] && continue
  DATE_SQL="NULL"
  [ -n "${MAXD:-}" ] && DATE_SQL="DATE '$MAXD'"
  SQL="$SQL
    UPDATE catalog.sources SET
      prev_row_count   = last_row_count,
      last_row_count   = $N,
      last_loaded_at   = TIMESTAMP '$LOADED',
      max_date_in_data = $DATE_SQL
    WHERE source_key = '$KEY';"
done <<< "$STATS"

if [ -n "$SQL" ]; then
  duckdb "$CAT" -c "$SQL" > /dev/null || { log "FATAL: could not write catalog stats"; exit 2; }
fi

N_UPDATED=$(duckdb "$CAT" -noheader -list -c "SELECT COUNT(*) FROM catalog.sources WHERE last_loaded_at IS NOT NULL;")
log "Catalog stats: $N_UPDATED source(s) updated, data as of $LOADED."
