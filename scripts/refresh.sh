#!/bin/bash
# The hourly job. Snapshot, archive, rebuild, in that order.
#
# Order matters and is not negotiable:
#   1. snapshot  - a consistent copy of the live fleet database
#   2. archive   - rescue new log rows to Parquet BEFORE the fleet app's 120 day
#                  retention can delete them. Reads the snapshot, not the live
#                  file, so it can never contend with the booking app.
#   3. build     - rebuild the bc.* layer from snapshot + archive. Capacity and
#                  booking pace come from the archive, so this must run last.
#
# If a step fails the later steps are skipped and the previous warehouse stays
# in place. Stale data is recoverable; a warehouse built from half a snapshot
# is a wrong answer nobody notices.
#
# Cron (hourly, at :35):
#   35 * * * * /var/www/becopenhagen-data/scripts/refresh.sh >> /var/lib/bc-data/logs/refresh.log 2>&1
#
# :35 is deliberate. The fleet's FareHarbor scraper runs at :00 and holds a
# write lock on fleet.db for the length of its run; the wiki curator runs at
# :20. This job stays out of both their way.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="/var/lib/bc-data/logs"
mkdir -p "$LOGDIR"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') [refresh] $*"; }

log "--- start ---"

if ! "$HERE/snapshot-fleet.sh"; then
  log "ABORT: snapshot failed. Previous warehouse left in place."
  exit 1
fi

if ! "$HERE/archive-logs.sh"; then
  # The archive is the one thing with a deadline (2026-10-26), so a failure here
  # is louder than a stale warehouse. Still don't build on it.
  log "ABORT: log archive failed. THIS IS THE ONE WITH A DEADLINE - investigate."
  exit 2
fi

if ! "$HERE/build-warehouse.sh"; then
  log "ABORT: warehouse build failed. Previous warehouse left in place."
  exit 3
fi

log "--- done ---"

# Keep the log readable rather than letting it grow forever. Everything worth
# keeping long term is in the archive, not in this file.
if [ -f "$LOGDIR/refresh.log" ] && [ "$(stat -c%s "$LOGDIR/refresh.log" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -n 2000 "$LOGDIR/refresh.log" > "$LOGDIR/refresh.log.tmp" && mv -f "$LOGDIR/refresh.log.tmp" "$LOGDIR/refresh.log"
fi
