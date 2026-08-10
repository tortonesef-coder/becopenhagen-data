#!/bin/bash
# Runs every check in the project. One command, so there is no excuse.
#
#   1. warehouse vs the LIVE fleet database   (are the numbers right)
#   2. data-level assertions                  (is anything out of bounds)
#   3. every canonical query executes         (will the agent's trusted SQL run)
#   4. catalog integrity                      (is anything undocumented)
#
# Run after ANY change to the SQL or the catalog. Exit code is the total number
# of failures across all four.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOTAL=0

run() {
  local title="$1" script="$2"
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo " $title"
  echo "════════════════════════════════════════════════════════════════"
  "$HERE/$script"
  local rc=$?
  TOTAL=$((TOTAL + rc))
  return 0
}

run "1/6  Warehouse against the live fleet database" verify-warehouse.sh
run "2/6  Data assertions"                           run-assertions.sh
run "3/6  Canonical queries"                         test-canonical.sh
run "4/6  Catalog integrity"                         verify-catalog.sh
run "5/6  Guide name matching"                      test-guide-matching.js.sh
run "6/6  Agent tools and safety"                   test-agent-tools.js.sh

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$TOTAL" -eq 0 ]; then
  echo " ALL CHECKS PASSED"
else
  echo " $TOTAL FAILURE(S) across all checks"
fi
echo "════════════════════════════════════════════════════════════════"
exit "$TOTAL"
