#!/bin/bash
# Cross-checks the warehouse against the LIVE fleet database.
#
# The warehouse is derived data. If it silently disagrees with the app Fede
# actually looks at, every answer the tool gives is wrong in a way nobody will
# notice for months. So this runs the same question against both sides and
# compares. It reads the live database read-only and writes nothing anywhere.
#
# Run after any change to the views. Exit code is the number of failed checks.

set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"   # cron's PATH omits /usr/local/bin

WH="/var/lib/bc-data/warehouse.duckdb"
FLEET="/var/www/becopenhagen-fleet/data/fleet.db"
FAILS=0

# A check compares one number from the warehouse against the same number
# computed independently from the live SQLite database.
check() {
  local label="$1" wh_sql="$2" fleet_sql="$3" tolerance="${4:-0}"
  local a b diff
  a=$(duckdb "$WH" -noheader -list -c "$wh_sql" 2>/dev/null | tail -1)
  b=$(sqlite3 "file:${FLEET}?mode=ro" "$fleet_sql" 2>/dev/null | tail -1)
  a=${a:-NULL}; b=${b:-NULL}

  if [ "$a" = "$b" ]; then
    printf '  ok    %-46s %s\n' "$label" "$a"
    return
  fi
  # Numeric tolerance, for anything that can move between the snapshot being
  # taken and this check running against the live file.
  if [ "$tolerance" != "0" ]; then
    diff=$(awk -v x="$a" -v y="$b" 'BEGIN{d=x-y; if(d<0)d=-d; print d}' 2>/dev/null)
    if awk -v d="$diff" -v t="$tolerance" 'BEGIN{exit !(d<=t)}' 2>/dev/null; then
      printf '  ok~   %-46s warehouse=%s live=%s (within %s)\n' "$label" "$a" "$b" "$tolerance"
      return
    fi
  fi
  printf '  FAIL  %-46s warehouse=%s live=%s\n' "$label" "$a" "$b"
  FAILS=$((FAILS + 1))
}

echo "Verifying $WH against the live fleet database"
echo "(small differences are expected: the snapshot is up to an hour behind)"
echo ""
echo "Row counts"
# Tolerance 150, not 25. The fleet's hourly scraper fetches four months forward
# and can add sixty or more departures in a single run, so a snapshot taken
# before it ran is legitimately that far behind. Observed 2026-08-10: 1142 in a
# 14-minute-old snapshot against 1203 live. A verifier that cries wolf on normal
# staleness gets ignored, which is worse than not having it.
check "tour departures" \
  "SELECT COUNT(*) FROM bc.departures;" \
  "SELECT COUNT(*) FROM tour_availabilities WHERE feed_type='tour';" 150
check "rental slots" \
  "SELECT COUNT(*) FROM bc.rental_slots;" \
  "SELECT COUNT(*) FROM tour_availabilities WHERE feed_type='rental';" 10
check "bookings" \
  "SELECT COUNT(*) FROM bc.bookings;" \
  "SELECT COUNT(*) FROM bookings;" 10
check "guide hour records" \
  "SELECT COUNT(*) FROM bc.guide_hours;" \
  "SELECT COUNT(*) FROM guide_tour_hours;" 5
check "reviews" \
  "SELECT COUNT(*) FROM bc.guide_reviews;" \
  "SELECT COUNT(*) FROM guide_reviews;" 2
check "active bikes" \
  "SELECT COUNT(*) FROM bc.fleet_bikes WHERE active=1;" \
  "SELECT COUNT(*) FROM bikes WHERE active=1;"

echo ""
echo "Business figures"
# The one most likely to be silently wrong: money is stored as the TEXT
# 'DKK1,200.00' and has to be parsed. A parse failure would show as a smaller
# total here, not as an error anywhere.
check "gross DKK, all bookings" \
  "SELECT CAST(ROUND(SUM(gross_dkk)) AS BIGINT) FROM bc.bookings;" \
  "SELECT CAST(ROUND(SUM(CAST(REPLACE(REPLACE(total,'DKK',''),',','') AS REAL))) AS INTEGER) FROM bookings;" 5000
check "bookings that failed to parse" \
  "SELECT COUNT(*) FROM bc.bookings WHERE gross_raw IS NOT NULL AND gross_dkk IS NULL;" \
  "SELECT 0;"
check "total pax, all tour departures" \
  "SELECT CAST(SUM(pax) AS BIGINT) FROM bc.departures;" \
  "SELECT SUM(booking_count) FROM tour_availabilities WHERE feed_type='tour';" 30
check "total bikes on tour departures" \
  "SELECT CAST(SUM(total_bikes) AS BIGINT) FROM bc.departures;" \
  "SELECT SUM(total_bikes) FROM tour_availabilities WHERE feed_type='tour';" 30
check "bikes unnested = bikes summed" \
  "SELECT CAST(SUM(bikes) AS BIGINT) FROM bc.departure_bikes;" \
  "SELECT SUM(total_bikes) FROM tour_availabilities WHERE feed_type='tour';" 30
check "guide hours total" \
  "SELECT CAST(ROUND(SUM(buffered_minutes)) AS BIGINT) FROM bc.guide_hours;" \
  "SELECT CAST(ROUND(SUM(duration_minutes)) AS INTEGER) FROM guide_tour_hours;" 300
check "distinct channels" \
  "SELECT COUNT(DISTINCT channel) FROM bc.bookings;" \
  "SELECT COUNT(DISTINCT COALESCE(NULLIF(source,''),'direct')) FROM bookings;"
check "bookings missing a real booked date" \
  "SELECT COUNT(*) FROM bc.bookings WHERE booked_date IS NULL;" \
  "SELECT COUNT(*) FROM bookings WHERE booking_created_at IS NULL OR booking_created_at='';" 10

echo ""
echo "Internal consistency"
check "every departure has a known product" \
  "SELECT COUNT(*) FROM bc.departures WHERE product_kind='unknown';" "SELECT 0;"
check "fill rate never exceeds 1.5" \
  "SELECT COUNT(*) FROM bc.departures WHERE fill_rate > 1.5;" "SELECT 0;"
check "fill rate never negative" \
  "SELECT COUNT(*) FROM bc.departures WHERE fill_rate < 0;" "SELECT 0;"
check "no fill rate on CUSTOM" \
  "SELECT COUNT(*) FROM bc.departures WHERE product_kind='custom_tour' AND fill_rate IS NOT NULL;" "SELECT 0;"
check "no pax without a departure date" \
  "SELECT COUNT(*) FROM bc.departures WHERE departure_date IS NULL;" "SELECT 0;"
check "archive holds every log row" \
  "SELECT COUNT(*) FROM read_parquet('/var/lib/bc-data/archive/tour_change_log/*.parquet');" \
  "SELECT COUNT(*) FROM tour_change_log;" 3000

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) FAILED."
fi
exit "$FAILS"
