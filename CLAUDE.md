# bc-data: how to work here

"Ask business questions in plain English, get answers grounded in real data." A DuckDB warehouse rebuilt hourly from a read-only snapshot of the fleet database, a catalog of definitions, gotchas, assertions and gaps, and an Ask page at `data.becopenhagen.dk` (pm2 `bc-data`, port 4200 on loopback, login restricted to `fede` and `soren`).

## Read before changing anything

1. `CLAUDE_CONTEXT.md`: Now, then Decisions, then the reference section for the part you touch (section 4 for how the fleet data really is, 7 for decisions, 7c for the warehouse, 7d for the catalog). Update it in the same commit.
2. `docs/plan-phase-1-sources.md`: the active plan (Amendment 01, applied in August; its priorities drive phases 5 to 7). The original spec is `docs/archive/2026-08-10-spec_data.md`; sections 6 and 6b of the context say where it is wrong.
3. `RUNBOOK.md` before touching the hourly refresh, the archive or the catalog store.
4. `/var/www/CLAUDE.md` for the workspace rules and the other repositories.

## Rules that never bend

- **Never open the fleet database writable.** Every path uses `mode=ro` or `READ_ONLY`; the tool proposes and observes and never writes to systems it does not own.
- **Do not modify anything under `/var/www/becopenhagen-fleet` from this project** (Fede, 10 August 2026). Capacity, history and every other number is harvested, not hand-maintained.
- The archive must keep running until at least 26 October 2026; a job that cannot fail loudly is worse than none.
- Build on the subscription, run on the API: scripts that spend API credit are `--api` opt-in. A doubt goes to Fede only if the answer lives in his head; never hand him a queue.
- Run `scripts/verify.sh` after any change to SQL or the catalog. No em or en dashes between words.

## Commands

```bash
node --experimental-sqlite src/server.js          # what pm2 runs
scripts/refresh.sh                                # the hourly job: snapshot, archive, rebuild (cron :35)
scripts/nightly.sh                                # the nightly queues (cron 03:20); only ever writes to a queue
scripts/verify.sh                                 # all suites: warehouse vs live fleet, assertions, canonical queries, catalog
duckdb /var/lib/bc-data/warehouse.duckdb          # poke around: SELECT * FROM bc.data_freshness;
duckdb /var/lib/bc-data/catalog_store.duckdb      # definitions, gotchas, gaps, corrections, every question asked
node scripts/bootstrap-columns.js --only-missing  # redraft column descriptions after a schema change (--api to spend)
node scripts/benchmark-models.js                  # measure, do not assume (spends API credit)
```

Environment in `.env`: `PORT`, `SESSION_SECRET`, `ALLOWED_MEMBERS`, `AGENT_MODEL`, `ANTHROPIC_API_KEY`, `FLEET_DB_PATH`, `WAREHOUSE_PATH`, `CATALOG_PATH`. Data lives under `/var/lib/bc-data/` (see `RUNBOOK.md`).

## Deploy

```
cd /var/www/becopenhagen-data && git pull && pm2 restart bc-data --update-env
```

The cron jobs pick up script changes on their next run; the restart is for the app.

Other documents: `JOURNAL.md` is Fede's plain-language log. `sql/README.md` and `sql/applied/README.md` explain which SQL runs every hour and which were one-off migrations. `docs/archive/` holds the original spec and the old README.
