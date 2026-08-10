#!/bin/bash
# Integrity checks on the catalog itself.
#
# The catalog is the product; the warehouse is plumbing. A table with no gotcha
# recorded, or a definition with no do-not-use note, is a silent hole: the agent
# will happily answer from it and nobody will know the guidance was missing.
# These checks make those holes visible.
#
# Exit code is the number of failed checks.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

WH="/var/lib/bc-data/warehouse.duckdb"
CAT="/var/lib/bc-data/catalog_store.duckdb"
FAILS=0

check() {
  local label="$1" sql="$2" expect="$3" db="${4:-$CAT}"
  local got
  got=$(duckdb "$db" -noheader -list -c "$sql" 2>&1 | tail -1)
  if [ "$got" = "$expect" ]; then
    printf '  ok    %-52s %s\n' "$label" "$got"
  else
    printf '  FAIL  %-52s got=%s want=%s\n' "$label" "$got" "$expect"
    FAILS=$((FAILS + 1))
  fi
}

note() {
  local label="$1" sql="$2"
  printf '  note  %-52s %s\n' "$label" "$(duckdb "$CAT" -noheader -list -c "$sql" 2>&1 | tail -1)"
}

echo "Catalog integrity"
echo ""

# Every table the agent can query must be documented, or it gets used blind.
# This spans both database files, so attach them into one session rather than
# trying to compare two separate query results in shell.
# duckdb_tables(), not information_schema: information_schema is scoped to the
# current database and is not reachable through an ATTACH alias.
UNDOCUMENTED=$(duckdb -noheader -list -c "
  ATTACH '$WH'  AS w (READ_ONLY);
  ATTACH '$CAT' AS c (READ_ONLY);
  SELECT COALESCE(string_agg('bc.' || table_name, ', '), '')
  FROM duckdb_tables()
  WHERE database_name = 'w' AND schema_name = 'bc'
    AND 'bc.' || table_name NOT IN (SELECT source_key FROM c.catalog.sources);
" 2>&1 | tail -1)

if [ -z "$UNDOCUMENTED" ]; then
  printf '  ok    %-52s %s\n' "every bc table has a catalog.sources row" "0 undocumented"
else
  printf '  FAIL  %-52s %s\n' "every bc table has a catalog.sources row" "undocumented: $UNDOCUMENTED"
  FAILS=$((FAILS + 1))
fi

# Which columns still have no drafted description, so an interrupted LLM pass is
# visible rather than quietly incomplete.
UNDRAFTED=$(duckdb -noheader -list -c "
  ATTACH '$WH'  AS w (READ_ONLY);
  ATTACH '$CAT' AS c (READ_ONLY);
  SELECT COALESCE(string_agg(t.table_name, ', '), 'none')
  FROM duckdb_tables() t
  WHERE t.database_name = 'w' AND t.schema_name = 'bc'
    AND NOT EXISTS (SELECT 1 FROM c.catalog.columns cc
                    WHERE cc.table_name = t.table_name AND cc.description IS NOT NULL);
" 2>&1 | tail -1)

check "every source has gotchas recorded" \
  "SELECT COUNT(*) FROM catalog.sources WHERE COALESCE(gotchas,'') = ''" "0"
check "every source has a grain" \
  "SELECT COUNT(*) FROM catalog.sources WHERE COALESCE(grain,'') = ''" "0"
check "every source has freshness stats" \
  "SELECT COUNT(*) FROM catalog.sources WHERE last_loaded_at IS NULL" "0"

check "every definition has a do-not-use note" \
  "SELECT COUNT(*) FROM catalog.definitions WHERE COALESCE(do_not_use,'') = ''" "0"
check "the mandatory date definition exists" \
  "SELECT COUNT(*) FROM catalog.definitions WHERE term = 'in July'" "1"
check "the alternative date term exists too" \
  "SELECT COUNT(*) FROM catalog.definitions WHERE term = 'booked in July'" "1"

check "every assertion has a message" \
  "SELECT COUNT(*) FROM catalog.assertions WHERE COALESCE(message,'') = ''" "0"
check "every assertion records where its bound came from" \
  "SELECT COUNT(*) FROM catalog.assertions WHERE bounds_source NOT IN ('measured','stated_by_fede')" "0"
check "no assertion bound is still a guess" \
  "SELECT COUNT(*) FROM catalog.assertions WHERE bounds_source = 'guessed'" "0"

check "every gap says how to get it" \
  "SELECT COUNT(*) FROM catalog.gaps WHERE COALESCE(how_to_get,'') = ''" "0"
# The amendment's v2 columns. grain and join_key are load-bearing: behaviour
# rules 12 and 13 cannot be honoured for a gap that has neither.
check "every gap has a grain" \
  "SELECT COUNT(*) FROM catalog.gaps WHERE COALESCE(grain,'') = ''" "0"
check "every gap says how it would join" \
  "SELECT COUNT(*) FROM catalog.gaps WHERE COALESCE(join_key,'') = ''" "0"
check "every gap has a valid category" \
  "SELECT COUNT(*) FROM catalog.gaps WHERE category NOT IN ('internal','official','open','competitive','derived')" "0"
check "every gap has a valid status" \
  "SELECT COUNT(*) FROM catalog.gaps WHERE status NOT IN ('gap','investigating','ingested','rejected','partial')" "0"
check "every limit says what it applies to" \
  "SELECT COUNT(*) FROM catalog.limits WHERE COALESCE(applies_to,'') = ''" "0"

# Phase 4 is the one session where Fede verifies these. Anything marked verified
# before that session happened would be a lie the agent then trusts verbatim.
check "no canonical query is verified before phase 4" \
  "SELECT COUNT(*) FROM catalog.canonical_queries WHERE verified_by IS NOT NULL" "0"
check "every canonical query has notes" \
  "SELECT COUNT(*) FROM catalog.canonical_queries WHERE COALESCE(notes,'') = ''" "0"

# Column drafts must never look reviewed when they are not.
check "no column description claims review it did not get" \
  "SELECT COUNT(*) FROM catalog.columns WHERE reviewed_by IS NOT NULL AND reviewed_at IS NULL" "0"
check "PII columns are flagged" \
  "SELECT COUNT(*) FROM catalog.columns WHERE column_name IN ('customer_name','customer_email','customer_phone') AND NOT is_pii" "0"

# A correction captured and then ignored is worse than not capturing it: it
# looks like the knowledge is in the system when nothing acts on it.
check "every applied correction records where it landed" \
  "SELECT COUNT(*) FROM catalog.corrections WHERE status = 'applied' AND COALESCE(applied_where,'') = ''" "0"
check "every correction says what it applies to" \
  "SELECT COUNT(*) FROM catalog.corrections WHERE COALESCE(applies_to,'') = ''" "0"
check "history is kept forever, per Fede 2026-08-10" \
  "SELECT COUNT(*) FROM catalog.settings WHERE key IN ('query_log_retention_days','corrections_retention_days') AND value <> 'forever'" "0"

echo ""
echo "Counts"
note "sources"            "SELECT COUNT(*) FROM catalog.sources"
note "definitions"        "SELECT COUNT(*) FROM catalog.definitions"
note "limits"             "SELECT COUNT(*) FROM catalog.limits"
note "gaps"               "SELECT COUNT(*) FROM catalog.gaps"
note "assertions"         "SELECT COUNT(*) FROM catalog.assertions"
note "canonical queries"  "SELECT COUNT(*) FROM catalog.canonical_queries"
note "columns drafted"    "SELECT COUNT(*) FROM catalog.columns"
note "columns reviewed by a human" "SELECT COUNT(*) FROM catalog.columns WHERE reviewed_by IS NOT NULL"
note "corrections captured" "SELECT COUNT(*) FROM catalog.corrections"
note "corrections not yet acted on" "SELECT COUNT(*) FROM catalog.corrections WHERE status = 'new'"
note "gaps (amendment v2 schema)" "SELECT COUNT(*) FROM catalog.gaps"
note "gaps that are comparison-only" "SELECT COUNT(*) FROM catalog.gaps WHERE join_key LIKE 'none:%'"

echo ""
echo "Outstanding"
printf '  tables with no drafted column descriptions: %s\n' "$UNDRAFTED"
printf '  columns awaiting Fede review: %s\n' \
  "$(duckdb "$CAT" -noheader -list -c 'SELECT COUNT(*) FROM catalog.columns WHERE reviewed_by IS NULL')"
printf '  canonical queries awaiting phase 4 verification: %s\n' \
  "$(duckdb "$CAT" -noheader -list -c 'SELECT COUNT(*) FROM catalog.canonical_queries WHERE verified_by IS NULL')"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "All catalog checks passed."; else echo "$FAILS check(s) FAILED."; fi
exit "$FAILS"
