#!/bin/bash
# Evaluates every DATA-level assertion in the catalog against the warehouse.
#
# Two kinds of assertion live in catalog.assertions:
#
#   target = 'bc.something'  a real SQL boolean over the warehouse. Executed
#                            here, on every load. These are the ones that catch
#                            a bad build before anyone queries it.
#
#   target = '*'             a RESULT-level rule about a single answer (does
#                            this result cover dates that do not exist, does it
#                            claim a net revenue figure). These reference helper
#                            predicates like result_covers_dates_before() which
#                            the agent layer implements in phase 3. They are
#                            skipped here by design, not by oversight.
#
# Exit code is the number of BLOCK assertions that failed. Warnings do not
# affect the exit code: they are reported alongside an answer, not instead of it.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

WH="/var/lib/bc-data/warehouse.duckdb"
CAT="/var/lib/bc-data/catalog_store.duckdb"
BLOCKED=0
WARNED=0
SKIPPED=0

echo "Evaluating data-level assertions"
echo ""

# chr(9) is a real tab; '\t' inside a DuckDB string literal is a literal
# backslash-t and silently produces one unsplittable field, which made the first
# version of this script report "0 assertions" while looking like it passed.
duckdb "$CAT" -noheader -list -c \
  "SELECT assertion_key || chr(9) || severity || chr(9) || replace(expression, chr(10), ' ')
     FROM catalog.assertions WHERE target <> '*' ORDER BY severity, assertion_key;" \
| while IFS=$'\t' read -r KEY SEV EXPR; do
    [ -z "${KEY:-}" ] && continue

    # Assertions whose expression is a description of a query-shape rule rather
    # than a data predicate cannot be evaluated against the warehouse either.
    case "$EXPR" in
      *query_touches_*|*query_filters_on*|*result_*)
        printf '  skip  %-34s (query-shape rule, agent layer)\n' "$KEY"
        SKIPPED=$((SKIPPED+1)); continue ;;
    esac

    RES=$(duckdb "$WH" -noheader -list -c "SELECT ($EXPR);" 2>&1 | tail -1)

    case "$RES" in
      true)  printf '  ok    %-34s\n' "$KEY" ;;
      false)
        if [ "$SEV" = "block" ]; then
          printf '  BLOCK %-34s\n' "$KEY"; BLOCKED=$((BLOCKED+1))
        else
          printf '  warn  %-34s\n' "$KEY"; WARNED=$((WARNED+1))
        fi ;;
      *)
        # An assertion that cannot be evaluated is a broken assertion, and a
        # broken assertion is worse than none: it looks like coverage.
        printf '  ERROR %-34s %s\n' "$KEY" "$RES"; BLOCKED=$((BLOCKED+1)) ;;
    esac
  # The while loop runs in a subshell, so the counters have to come back out
  # through the exit status rather than through variables.
  done > /tmp/bc-assert.$$ 2>&1
cat /tmp/bc-assert.$$
B=$(grep -c '^  BLOCK\|^  ERROR' /tmp/bc-assert.$$ || true)
W=$(grep -c '^  warn'  /tmp/bc-assert.$$ || true)
S=$(grep -c '^  skip'  /tmp/bc-assert.$$ || true)
rm -f /tmp/bc-assert.$$

echo ""
echo "$B blocking, $W warning, $S skipped (result-level, evaluated by the agent in phase 3)."
exit "$B"
