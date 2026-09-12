# becopenhagen-data (bc-data)

Ask business questions in plain English, get answers grounded in real
BeCopenhagen data. Read only, everywhere, always.

Read `CLAUDE_CONTEXT.md` before changing anything. `spec_data.md` is the
original build specification; where the two disagree, CLAUDE_CONTEXT wins,
because the spec was written before anyone had read the fleet schema.

## Status

Phase 1 complete. The warehouse is live and refreshing hourly. There is no web
app yet (phase 3).

## The hourly job

```
35 * * * * /var/www/becopenhagen-data/scripts/refresh.sh >> /var/lib/bc-data/logs/refresh.log 2>&1
```

Runs at `:35` to stay clear of the fleet scraper at `:00` and the wiki curator
at `:20`. Takes about 3 seconds.

| Script | Does |
|---|---|
| `scripts/snapshot-fleet.sh` | Read-only copy of the live fleet database |
| `scripts/archive-logs.sh` | Rescues log rows to Parquet before the fleet app's 120 day retention deletes them |
| `scripts/build-warehouse.sh` | Rebuilds the `bc.*` layer from `sql/build-warehouse.sql` |
| `scripts/verify-warehouse.sh` | Cross-checks 22 figures against the live fleet database |
| `scripts/refresh.sh` | Chains the first three, in order |

## Poking around

```bash
duckdb /var/lib/bc-data/warehouse.duckdb
```

```sql
SELECT * FROM bc.data_freshness;              -- what "data as of" means right now
SELECT * FROM bc.departures LIMIT 10;         -- every departure offered, sold or not
SELECT * FROM bc.booking_pace LIMIT 10;       -- how bookings accumulated before departure
```

## Rules

- **Never open the fleet database writable.** It is the live booking app's data.
  Every path here uses `mode=ro` or `READ_ONLY`, and SQLite enforces it.
- **Do not modify anything under `/var/www/becopenhagen-fleet`.** Fede's
  instruction, 2026-08-10.
- Run `scripts/verify-warehouse.sh` after any change to the views.
- Update `CLAUDE_CONTEXT.md` in the same commit as any change.

## Deploy

```
cd /var/www/becopenhagen-data && git pull && pm2 restart bc-data --update-env
```

The `pm2 restart` only applies from phase 3, when there is an app to restart.
Until then `git pull` is the whole deploy: the cron picks up script changes on
its next run.

## Verifying

```bash
/var/www/becopenhagen-data/scripts/verify.sh
```

Runs all four suites: warehouse against the live fleet database, data
assertions, every canonical query executed, catalog integrity. Run it after any
change to the SQL or the catalog.

## The catalog

`/var/lib/bc-data/catalog_store.duckdb` holds what must survive the hourly
rebuild: agreed definitions, recorded mistakes, and every question asked.

```bash
duckdb /var/lib/bc-data/catalog_store.duckdb
```

```sql
SELECT term, definition FROM catalog.definitions;   -- what words mean here
SELECT source_key, gotchas FROM catalog.sources;    -- what will bite you
SELECT * FROM catalog.gaps ORDER BY cited_count DESC;
```

To redraft column descriptions after a schema change:

```bash
node scripts/bootstrap-columns.js --only-missing
```
