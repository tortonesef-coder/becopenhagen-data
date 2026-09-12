# bc-data runbook

What runs, where the data is, and what to do when something is wrong. The app is pm2 `bc-data` (port 4200, loopback, behind Caddy at `data.becopenhagen.dk`).

## What runs

| When (UTC) | Command | Does |
|---|---|---|
| every hour at :35 | `scripts/refresh.sh` (cron, log `/var/lib/bc-data/logs/refresh.log`) | snapshot the fleet database read-only, archive new log rows to Parquet, rebuild the `bc.*` warehouse; about 3 seconds; :35 stays clear of the fleet scraper (:00) and the wiki curator (:20) |
| 03:20 daily | `scripts/nightly.sh` (log `/var/lib/bc-data/logs/nightly.log`) | the doubts and curator queues; only ever writes to a queue, never changes a number |
| on demand | `scripts/verify.sh` | every suite; run after any change to SQL or the catalog |

The scripts set `PATH` explicitly because `duckdb` lives in `/usr/local/bin`, which cron does not have.

| Script | Does |
|---|---|
| `scripts/snapshot-fleet.sh` | read-only copy of the live fleet database into `snapshots/fleet.db` |
| `scripts/archive-logs.sh` | rescues log rows to Parquet before the fleet's 120-day retention deletes them; aborts loudly on any failure |
| `scripts/build-warehouse.sh` | rebuilds `bc.*` from `sql/build-warehouse.sql` (plus `build-catalog-views.sql`, `build-uploads.sql`) |
| `scripts/verify-warehouse.sh` | cross-checks 22 figures against the live fleet database (tolerance scales with snapshot age) |

## Where the data is

`/var/lib/bc-data/`: `warehouse.duckdb` (rebuilt hourly, disposable), `catalog_store.duckdb` (what must survive: definitions, corrections, doubts, every question asked; back it up), `snapshots/fleet.db` (the hourly copy), `raw/` and `archive/` (Parquet, append-only, the permanent log archive), `uploads/`, `logs/`. All of it is in the nightly restic backup (service `data` in `bc-backup-lib.sh` on the fleet side).

## When something is wrong

- **Ask says the account has no credit**: Anthropic API balance; Fede tops it up in the console (auto-reload was set on 10 August).
- **Freshness chip is old**: check `/var/lib/bc-data/logs/refresh.log` for the last run; run `scripts/refresh.sh` by hand; if `duckdb` is missing from PATH the log says so.
- **verify fails "warehouse pax above live"**: usually staleness (the snapshot predates the fleet scraper's cancellation sweep); refresh and re-run before assuming a bug.
- **The app is down**: `pm2 logs bc-data --lines 50`; `pm2 restart bc-data --update-env`. A template-literal quoting mistake in the behaviour rules took it down once (10 August); the health check caught it within a minute.
- **A doubt Fede answered was recorded wrongly**: notes are corrections whichever button was pressed and a note stops the write-back; check `catalog.corrections` and `catalog.doubts.note`.
- **The archive stopped**: the hard deadline is 26 October 2026 for the oldest fleet rows; an archive that is not running by then loses log history for good. Check the log, run `scripts/archive-logs.sh`, confirm row counts are integers and rising.

## Deploy

```
cd /var/www/becopenhagen-data && git pull && pm2 restart bc-data --update-env
```
