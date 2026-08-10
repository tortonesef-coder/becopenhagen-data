#!/bin/bash
# The nightly job: look at the catalogue and decide what to ask a person about.
#
# Two steps, both of which only ever WRITE TO A QUEUE. Neither changes a source,
# a number or an answer. That is what makes it safe to run unattended:
#
#   1. doubts   - everything the models are unsure about, as yes-or-no questions
#   2. curator  - data that cannot be reached, links being missed, documents
#                 whose numbers are not queryable yet
#
# Nightly rather than hourly on purpose. Their inputs change on the timescale of
# days, and the scarce resource here is Fede's attention: a queue that grows
# every hour is a queue nobody opens.
#
# Cron (daily, 03:20):
#   20 3 * * * /var/www/becopenhagen-data/scripts/nightly.sh >> /var/lib/bc-data/logs/nightly.log 2>&1
#
# 03:20 is after the :35 refresh has finished and well clear of the fleet
# scraper, so the catalogue it reads is settled.

set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"   # cron's PATH omits /usr/local/bin

HERE="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="/var/lib/bc-data/logs"
mkdir -p "$LOGDIR"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') [nightly] $*"; }

command -v duckdb > /dev/null || { log "FATAL: duckdb not on PATH"; exit 1; }

log "--- start ---"

# Neither step gates the other: they queue independent things, and a failure in
# one is not a reason to skip the other. But both failing silently would leave
# the queues quietly frozen, so each says so.
if ! node "$HERE/generate-doubts.js"; then
  log "WARNING: doubt generation failed. The existing queue is untouched."
fi

if ! node "$HERE/curator.js"; then
  log "WARNING: curator failed. No new proposals this run."
fi

log "--- done ---"

if [ -f "$LOGDIR/nightly.log" ] && [ "$(stat -c%s "$LOGDIR/nightly.log" 2>/dev/null || echo 0)" -gt 2097152 ]; then
  tail -n 1000 "$LOGDIR/nightly.log" > "$LOGDIR/nightly.log.tmp" && mv -f "$LOGDIR/nightly.log.tmp" "$LOGDIR/nightly.log"
fi
