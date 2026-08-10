#!/bin/bash
# Executes every canonical query against the warehouse.
#
# A canonical query the agent is told to trust VERBATIM is worse than no
# canonical query if it does not run, because the agent will use it without
# checking. So every one gets executed here, and this runs after any change to
# the catalog.
#
# Queries containing ${placeholders} are parameterised (e.g. ${date}); a stand-in
# value is substituted so the SQL still gets parsed and executed.
#
# Exit code is the number that failed.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

WH="/var/lib/bc-data/warehouse.duckdb"
CAT="/var/lib/bc-data/catalog_store.duckdb"
OUT=$(mktemp)

duckdb "$CAT" -noheader -list -c \
  "SELECT query_key || chr(9) || replace(replace(sql, chr(10), ' '), chr(9), ' ')
     FROM catalog.canonical_queries ORDER BY query_key;" \
| while IFS=$'\t' read -r KEY SQL; do
    [ -z "${KEY:-}" ] && continue
    # Substitute a real date for any parameter placeholder so the query parses.
    RUNNABLE=$(echo "$SQL" | sed "s/\${date}/DATE '2026-08-03'/g; s/\${[a-z_]*}/'A3'/g")
    ROWS=$(duckdb "$WH" -noheader -list -c "SELECT COUNT(*) FROM ($RUNNABLE);" 2>&1 | tail -1)
    case "$ROWS" in
      ''|*[!0-9]*) printf '  FAIL  %-26s %s\n' "$KEY" "$(echo "$ROWS" | head -c 130)" ;;
      0)           printf '  empty %-26s (runs, returns no rows)\n' "$KEY" ;;
      *)           printf '  ok    %-26s %s rows\n' "$KEY" "$ROWS" ;;
    esac
  done > "$OUT" 2>&1

cat "$OUT"
F=$(grep -c '^  FAIL' "$OUT" || true)
T=$(grep -c '^  ' "$OUT" || true)
rm -f "$OUT"
echo ""
echo "$T canonical queries, $F failed."
exit "$F"
