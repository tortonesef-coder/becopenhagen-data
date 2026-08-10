# CLAUDE_CONTEXT.md
# BeCopenhagen Data (bc-data) — Permanent Configuration & State Document
# Last updated: 2026-08-10

> **MAINTENANCE RULE, READ FIRST:** This file must be kept up to date with every
> change made to this repo, AND it must be actively referred to before making
> changes, not just written to afterwards. Any time a file is added, a schema is
> altered, a view or route is created or removed, a phase ships, or an open
> question is resolved, update the relevant section of this document **in the
> same commit** as the change itself. Before starting nontrivial work, read the
> relevant sections first. It exists to make you smarter about this codebase,
> not just to record history.

> **HOUSE STYLE:** no em dashes or en dashes as punctuation between words. Use
> commas, colons or parentheses. Hyphens inside compound words are fine. Applies
> to UI copy, error messages, agent prompts and these docs.

---

## 1. What this is

A natural-language query tool over BeCopenhagen's operational data plus Danmarks
Statistik, for two non-technical users (Fede and Søren). Ad hoc, read only, no
dashboards, no scheduled reports.

The defining behavioural requirement is scepticism: the tool must say what it
cannot know, name alternative explanations, and refuse causal-sounding sentences
the data cannot support. A confident wrong answer is the primary failure mode.

The full build specification is `spec_data.md`, committed alongside this file.
Where this document and `spec_data.md` disagree, **this document wins**, because
the spec was written before anyone had read the fleet schema. Section 6 below
records every place the spec turned out to be wrong.

---

## 2. Environment

| Item | Value |
|---|---|
| Repo | `tortonesef-coder/becopenhagen-data` |
| Path | `/var/www/becopenhagen-data` |
| pm2 process | `bc-data` (**live**, port 4200) |
| Subdomain | `data.becopenhagen.dk` (**Caddy ready, DNS points elsewhere**, see phase 3 log) |
| Data directory | `/var/lib/bc-data/` (**live**, mode 700) |
| Warehouse | `/var/lib/bc-data/warehouse.duckdb` (**live**, DuckDB 1.5.5) |
| Port | **4200**. 3456 is bc-fleet, 4100 is bc-wiki, 3000 is the Life OS router |

### Data directory layout

```
/var/lib/bc-data/
├── snapshots/fleet.db      hourly read-only copy of the live fleet database
├── snapshots/_loaded_at    UTC timestamp of that copy, the "data as of" source
├── archive/<table>/*.parquet   permanent, append-only, zstd. Never deleted
├── warehouse.duckdb        the bc.* layer, rebuilt hourly, swapped atomically
├── raw/                    phase 6, Statbank parquet landing
└── logs/refresh.log        hourly job output, self-trimming at 5 MB
```

`duckdb` CLI is installed at `/usr/local/bin/duckdb`.

Deploy line, at the end of every push:

```
cd /var/www/becopenhagen-data && git pull && pm2 restart bc-data --update-env
```

### Neighbours on this VPS

Hetzner VPS, Ubuntu 24, 4GB RAM, Caddy reverse proxy (`/etc/caddy/Caddyfile`),
pm2 for every app. Five node processes run here and one of them is the live
booking app, so never kill node processes broadly.

| pm2 name | What | Port | Notes |
|---|---|---|---|
| `bc-fleet` | The live fleet/booking app, `app.becopenhagen.dk` | 3456 | Owns `data/fleet.db` |
| `bc-wiki` | Internal wiki, `wiki.becopenhagen.dk` | 4100 | Reads fleet.db read only for logins. The auth precedent |
| `bc-brain` | Earlier analytics prototype, see section 5 | see `brain/.env` | Not in the spec. Overlaps this project heavily |
| `bc-data` | This app, `data.becopenhagen.dk` | 4200 | Reads fleet.db read only for logins |
| `router`, `list` | Life OS, unrelated | 3000 | Do not touch |

### Cron on this box

```
0  *  * * *  bc-fleet FareHarbor guide-schedule scraper (v2)
20 *  * * *  bc-wiki curator
0  6  * * 1  bc-brain weekly analyst briefing
0  3  * * *  bc-fleet nightly backup
30 3  * * *  bc-fleet backup watchdog
35 *  * * *  bc-data refresh (snapshot, archive, rebuild, assertions)
```

Any bc-data cron must not collide with the top of the hour, which already has
the fleet scraper taking a write lock on fleet.db.

---

## 3. Stack conventions inherited from bc-fleet and bc-wiki

Follow these unless there is a stated reason not to.

- Node.js 22, built-in `node:sqlite` (`DatabaseSync`), run with
  `--experimental-sqlite`. No better-sqlite3.
- Express 4, `express-session`, no ORM.
- pm2 `ecosystem.config.js` with an absolute `cwd` and `node_args`, because pm2
  runs `src/server.js` directly and never goes through `npm start`.
- Secrets in `.env` (gitignored) plus `/etc/environment` for the shared ones
  (`ANTHROPIC_API_KEY`, `SMTP_*`, `FAREHARBOR_*`). pm2 does not inherit
  `/etc/environment`; bc-fleet reads it manually at startup.
- Timestamps stored as TEXT via `datetime('now')`, UTC. Booleans as INTEGER 0/1.
- Usernames are `team_members.id` from fleet.db (`fede`, `soren`, `zac`, ...).
- Email via nodemailer, Simply.com SMTP, `smtp.simply.com:587`, sender
  `noreply@becopenhagen.dk`.
- Session cookie must be named something other than `connect.sid` and other than
  `wiki.sid`. Cookies ignore ports, so a shared name collides with the other two
  apps during IP testing.

### Auth: the pattern to copy

`bc-wiki/src/fleet-auth.js` is the reference implementation and bc-data copies it
verbatim in shape:

1. Open `/var/www/becopenhagen-fleet/data/fleet.db` with
   `new DatabaseSync(path, { readOnly: true })` and
   `PRAGMA busy_timeout = 5000`. SQLite itself enforces read only, so this app
   cannot write fleet data even by mistake.
2. On login, look up `team_members` by `lower(email) = lower(?) AND active = 1`,
   take the first match (`email` has no UNIQUE constraint, and the fleet app also
   takes the first match, so both apps let in exactly the same person).
3. Verify with `crypto.scryptSync(password, salt, 64)` where **the salt is passed
   as its 32 character hex STRING, not hex decoded**. Getting this wrong makes
   every login silently fail.
4. Reject when `needs_password_setup` or `password_hash` is empty, and tell the
   person to set the password in the fleet app. Password setup, reset and email
   change stay in bc-fleet. bc-data never writes a credential anywhere.
5. Issue this app's own session cookie on its own subdomain. Store the fleet
   `member.id` in the session and nothing else; re-read role on each request.
6. Boot probe: count active members at startup so a broken path shows up in the
   logs rather than as a mysterious 503 at first login.

bc-data has only two users, so it should additionally restrict access to
`fede` and `soren` rather than letting every guide in.

---

## 4. The fleet database, as it actually is

Path: `/var/www/becopenhagen-fleet/data/fleet.db`. SQLite, WAL, about 471 MB.
Two writers: the `bc-fleet` app process (iCal sync every 90 seconds, webhooks,
UI) and the hourly v2 FareHarbor scraper cron.

### The one fact that reshapes this project

**The fleet database begins on 2026-06-28.** Every table starts then or later.
There is no 2023, 2024 or 2025 in it. Booking and revenue history back to
December 2022 exists only in `bc-fleet/brain/analytics.db`, built by hand from
FareHarbor CSV exports (section 5).

Consequences: no season-over-season comparison, no year-over-year, no trend, and
no `>= 2019-01-01` assertion, from fleet data alone.

### Ownership rules between the two writers

These are load bearing. Breaking them makes the two writers oscillate.

- The v2 scraper owns **tour** bike counts (from FareHarbor `resource_use_summaries`)
  and tour pax. iCal skips tour bike counts entirely.
- iCal owns **rental** bike counts, parsed from booking text.
- Both writers are sticky on null for `guide`: `guide = COALESCE(excluded.guide, guide)`.
  Neither ever clears a guide in place.
- `booking_count` on a **tour** row means PEOPLE (pax, FareHarbor `customer_count`).
  On a **rental** row it means RESERVATIONS. Same column, two meanings.
- Past tours are frozen: once `start_date < today`, iCal stops recomputing the
  row and v2 skips past days. Changing history requires a deliberate migration.

### Retention

`src/log-retention.js` deletes rows older than 120 days from `action_log`,
`tour_change_log`, `page_views`, `emails_sent`, `webhook_log`, dismissed
`admin_notifications` and `tour_reminders`. It does not touch `bookings`,
invoices, bug reports or `guide_unavailability`. So the audit trail is a rolling
120 day window and any bc-data view over it inherits that horizon.

### Tables (row counts as of 2026-08-10)

Business data:

| Table | Rows | Date column(s) | Range | Notes |
|---|---|---|---|---|
| `bookings` | 709 | `booking_created_at`, `tour_start_date` | created 2026-04-05..2026-08-10, tour 2026-07-01..2026-09-19 | Permanent ledger, never deleted. See gotchas below |
| `tour_availabilities` | 1216 | `start_date` | tours 2026-07-07..2026-12-06, rentals 2026-08-03..2026-09-14 | Every departure offered, sold or not. The only source of empty departures |
| `guide_tour_hours` | 153 | `start_date` | 2026-06-24..2026-09-18 | Only for departures with an assigned guide |
| `guide_reviews` | 111 | `review_date` | 2026-06-24..2026-08-06 | Manually logged. 50 DKK bonus per 5 star review biases this twice |
| `pending_assignments` | 718 | `booking_date`, `created_at` | booking 2026-05-19..2027-06-01 | Rental bike allocation queue |
| `bikes` / `bike_types` / `bike_status` | 105 / 12 / 94 | `created_at` | 2026-06-28..2026-07-18 | 104 active bikes. `bikes.created_at` is when the row was seeded, not purchase date |
| `repair_tickets` | 10 | `created_at` | 2026-06-28..2026-07-14 | |
| `team_members` | 11 | none | | 10 active, 8 guides |

Logs and machinery (120 day retention, low analytical value):
`tour_change_log` (283,521 rows, most of the 471 MB), `action_log` (2556),
`page_views` (3762), `emails_sent` (517), `webhook_log` (1261),
`admin_notifications` (379), plus dedup marker tables (`tour_reminders`,
`tour_cancel_notified`, `tour_missing`, `fareharbor_availability_cache`) and
auth tables (`password_resets`, `email_verifications`, `shop_pin`,
`notification_prefs`).

### Gotchas that must end up in `catalog.sources.gotchas`

1. `bookings.total` is TEXT in the form `DKK1,200.00`. Not a number. Parsing is
   `CAST(REPLACE(REPLACE(total,'DKK',''),',','') AS REAL)`.
2. `bookings` has **no cancellation flag**. A cancelled booking stops appearing
   in the iCal feed and its ledger row stays forever, unchanged. Only
   `last_seen_at` going stale hints at it. Any revenue figure from this table is
   gross of cancellations and gross of OTA commission.
3. `bookings.booking_created_at` is NULL on 286 of 709 rows (40%), almost all
   rentals, because Airbnb and rental bookings do not fire the FareHarbor
   webhook. `first_seen_at` (when our sync first spotted it, usually within 90
   seconds) is the honest fallback and the UI labels it "approx".
4. `booking_count` means pax on tours and reservations on rentals.
5. `tour_availabilities` for rentals is a short rolling cache, roughly a week
   back, not a full history. The `bookings` ledger is the durable rental record.
6. `bikes_needed` is a JSON object keyed by bike type code, for example
   `{"A":3,"GT":4}`. `total_bikes` is its sum.
7. Private tours (feed_id ending `P`, plus `CUSTOM`) are open capacity, not
   scheduled departures. A private slot with zero bookings is not an empty tour
   and must be excluded from fill rate, or every private product reads as ~0%
   sold. This has already produced a wrong finding in the bc-brain weekly
   briefing.
8. `guide_tour_hours.duration_minutes` is buffered wall time, not tour length:
   F3/F3P get 30+30 minutes, everything else 15+15.

### Tour codes

Group: `A3` architecture, `L3` liveability, `F3` food, `H3` history, plus
`A3G` German and `A3F` French. Private: `A3P`, `L3P`, `F3P`, `H3P`, `L2P`,
plus `CUSTOM`. Rentals: `1-D` through `14-D`, N day bike rental.
Legacy codes only present in `analytics.db`: `ESS` became `L3`, `ARCH` became
`A3`, `L2` was discontinued in 2026.

Channels seen in fleet `bookings.source`: `direct` (518), `GetYourGuide` (100),
`Airbnb` (73), `TripAdvisor` (17), `Viator` (1).

---

## 5. bc-brain: the prior art, and the reason this project exists

`/var/www/becopenhagen-fleet/brain/`, pm2 process `bc-brain`. Not mentioned in
`spec_data.md` beyond open question 8, but it is 80% of what the spec describes,
already built and already running.

What it is:

- `analytics.db` (SQLite): `bookings` (3217 rows, Dec 2022 to 2026-07-15),
  `sales` (3602 payment and refund events), `customer_types` (8186 line items,
  the only place bike type per booking lives).
- `load.js` rebuilds those three tables from **three FareHarbor CSV exports**:
  bookings (detailed), sales, and customers. It sniffs which file is which from
  the column signature (`Payment or Refund ID`, `Customer type`, `Cancelled?`)
  so files can never be crossed, and it warns when an export was run on
  "Availability date" instead of "Booking created date".
- `server.js` attaches the LIVE fleet.db read only via
  `ATTACH DATABASE 'file:...?mode=ro' AS fleet`, and answers questions with
  Claude plus a SELECT-only `run_sql`.
- `context.md` is a hand-curated business context file with verified and
  unverified lines, injected on every question.
- `analyst.js` runs a weekly deterministic metric battery, hands it to Claude,
  and emails a briefing. Cron: Mondays 06:00.

Why it matters to this build:

- It already answers spec open question 1 (which FareHarbor reports) and
  substantially answers 4.2's ingestion mapping.
- Its `schema.txt` is a working draft of the `catalog.columns` descriptions and
  the `catalog.limits` rules, written against real data.
- It is currently **stale**: last CSV load 2026-07-15, and the last analyst run
  ended `Analysis failed: Analysis did not converge to a briefing`.
- Its failure modes are the ones the spec is trying to prevent, and they are
  visible in `analyst.log`: private-tour slots reported as 58 of 58 empty, and a
  product called a growth story one week and a collapse the next off a 28 day
  window. Both are small-n and supply-versus-demand errors.

**DECIDED 2026-08-10 (Fede): retire bc-brain, do not port `analytics.db`.**
Stated reason: "I want the cleanest build", and the underlying data exists
elsewhere. That reading is correct, with one caveat recorded below.

What this means in practice:

- `analytics.db` is **not** a bc-data source. Nothing is built on it.
- The long history is not lost, because `analytics.db` was only ever derived.
  Its source is FareHarbor, re-exportable at any time, and the three CSVs it was
  last built from are still on disk at `brain/uploads/` (dated 2026-07-15).
- The history therefore returns via **phase 5**, when the FareHarbor report
  ingestion loads those same exports directly into the clean warehouse. Between
  phase 1 and phase 5, bc-data can only see back to 2026-06-28 and must say so
  in every answer rather than implying it has seen more.
- What is worth salvaging from bc-brain is documentation, not data: `schema.txt`
  and `context.md` seed `catalog.columns`, `catalog.definitions` and
  `catalog.limits`; `load.js`'s report sniffing and basis validation are the
  reference for the phase 5 ingestion. Read them, do not import them.
- **Sequencing:** do not stop the `bc-brain` pm2 process until bc-data can
  answer the same questions, otherwise there is a window where neither works.

**CAVEAT, unresolved:** `scripts/backup.sh` backs up `fleet.db` only. Neither
`brain/analytics.db` nor `brain/uploads/*.csv` is in any backup, local or
off-site, and `brain/.gitignore` excludes both. If this VPS died today, the only
surviving copy of the pre-2026-06-28 history would be FareHarbor's own records.
Copy `brain/uploads/{bookings,sales,customers}.csv` somewhere backed up before
anything is retired.

---

## 6. Where `spec_data.md` is wrong

Recorded so the errors are not rebuilt from the spec later.

1. **§3.5 assertion `no departure before company start >= 2019-01-01`.** Fleet
   data starts 2026-06-28. The assertion would pass trivially and prove nothing.
2. **§3.4 canonical query "season over season comparison".** Impossible from
   fleet data. Possible only from `analytics.db`.
3. **§2 "hourly `.backup`" and "`_loaded_at` up to one hour stale".** Fine for
   the schedule, but `sqlite3 .backup` copies the whole 471 MB file, of which
   about 95% is `tour_change_log` audit rows nobody will query. Copy selectively
   or accept 11 GB a day of write churn.
4. **§4.1 "Claude Code must read the actual fleet schema in phase 0".** Done, and
   the schema does not support most of §3's examples. `grain` of
   `one row per booking per pax` does not exist anywhere in fleet.db; the closest
   thing is `analytics.db.customer_types`.
5. **§3.1 example gotcha "bookings include cancelled records, filter on status".**
   There is no status column in fleet `bookings` to filter on. `analytics.db`
   has `cancelled`.
6. **§12.5 "which date is canonical".** Both dates exist in fleet `bookings`,
   but `booking_created_at` is NULL on 40% of rows, so a booking-date answer
   silently drops 40% of bookings unless it falls back to `first_seen_at`.
7. **§0 "Not a wiki ... must not be built inside it".** Correct, but the wiki's
   own Q&A agent already exists and this app must not duplicate it either.
8. **§12.8 treats the brain as a curiosity.** It is the closest existing thing to
   this product and holds the only long history. It belongs in section 4, not in
   the open questions.

---

## 7. Decisions taken

### 2026-08-10, bc-brain

Retire it, do not port its data. Full detail and the backup caveat in section 5.

### 2026-08-10, log retention

**Do not touch the fleet app. Archive everything in bc-data instead.**
Fede's words: "I can't afford breaking the fleet app for now, so don't touch it,
but I also don't want to lose data starting around 26th October, I want to save
all data. We can debloat and clean later on if needed."

So the known phantom-logging bug in `ical.js` (§4, 62% of `tour_change_log`)
stays unfixed for now, and bc-data must become the permanent archive of the
fleet's log tables before the first 120 day deletion.

- **Hard deadline: 2026-10-26.** That is 120 days after the oldest surviving row
  (2026-06-28). Nothing has been deleted yet. If the archive is not running by
  then, log history starts disappearing and is not recoverable.
- The archive is append-only: every hourly snapshot inserts log rows the archive
  has not seen before and never deletes. It must cover `tour_change_log`,
  `action_log`, `page_views`, `emails_sent`, `webhook_log`,
  `admin_notifications` and `tour_reminders`.
- **Store as compressed Parquet, not raw.** At the current rate
  (283k rows / 6 weeks, ~1.6 KB per row because of the capped `raw_data` JSON
  blob) the raw growth is roughly 11 GB a year against 29 GB free on a 38 GB
  disk. Parquet with dictionary + zstd compression on data this repetitive
  brings that under 1 GB a year with zero loss. This is what makes "save all
  data" affordable without touching the fleet app.
- Revisit the fleet-side bug fix once the fleet app is calm enough to change.
  It would cut `tour_change_log` by ~62% at source and shrink `fleet.db` by
  roughly 450 MB.

### 2026-08-10, capacity: do not hand-maintain it, harvest it

Fede gave the numbers: 12 on every tour except F3 which is 10; private sells at
max 16 but he will exceed it on request; CUSTOM has no limit. He then asked
whether the tool needs a settings page for this, or could auto-update.

**Auto-update. FareHarbor already publishes capacity per availability and the
fleet scraper already downloads it, then discards it.** Confirmed read-only
against the payloads captured in `tour_change_log.raw_data`. FareHarbor's own
numbers match Fede's answer exactly:

| Code | FareHarbor `capacity` | Departures sampled |
|---|---|---|
| A3 | 12 | 49 |
| L3 | 12 | 21 |
| H3 | 12 | 3 |
| A3G | 12 | 6 |
| F3 | 10 | 5 |
| A3P | 16 | 6 |
| CUSTOM | 25 | 2 |

The payload also carries `bookable_capacity`, `reserved_capacity`,
`non_resource_bookable_capacity` and `blocks_included_bookable_capacity`.
`capacity` is the seat limit; `bookable_capacity` is what is still sellable and
moves as bookings and resource blocks land.

**Design consequence: capacity belongs on each departure row, not in a products
table.** Per-departure capture handles every case Fede raised for free: a
private group he lets past 16, CUSTOM having no fixed limit, and the numbers
changing in future. A static `bc.products` capacity column would need editing
every time and would silently be wrong in between.

`bc.products` therefore shrinks to a small dimension table (name, is_private,
status, legacy codes) with **no capacity column**, plus an optional manual
override for the rare case where FareHarbor itself is wrong.

**How to get it without touching the fleet app** (Fede's constraint, see above):

- **Backfill:** mine `tour_change_log.raw_data` for `"capacity"`. 103,194 rows
  contain it. Caveat: `raw_data` is capped at 4000 characters by the scraper, so
  some payloads are truncated mid-JSON and must be regex-scanned, not parsed.
  Also only covers departures logged since 2026-07-07 and dies with the 120 day
  retention, so harvest it into the archive early.
- **Going forward:** bc-data does its own read-only FareHarbor calendar fetch.
  Do NOT modify `scrape-guide-schedule-v2.js` to store capacity, however
  tempting and however small the change: the fleet app is off limits.
- **Sequencing:** fold the capacity fetch into the phase 5 FareHarbor work,
  which already needs its own authenticated session, rather than standing up a
  second FareHarbor login earlier than necessary. Until then, seed capacity from
  the backfill plus Fede's stated defaults (12 / F3 10 / private 16 / CUSTOM
  unlimited) and mark the source of each value so the agent can say which it used.

Also confirmed by Fede: A3F and H3P are not retired, they simply have not run
yet. Keep them active, and exclude never-run products from averages by checking
departure count, not by a status flag.

### 2026-08-10, PII

**Allow customer details when explicitly asked for.** Aggregate by default
(behaviour rule 8 stands), but the agent may return an identified customer when
the question is explicitly about one. Consequences to implement:

- Flag `customer_name`, `customer_email`, `customer_phone` as `is_pii` in
  `catalog.columns`, but do **not** block them from `run_sql` output.
- Customer names, emails and phone numbers will therefore sometimes be sent to
  the Anthropic API. Deliberate, per §8 of the spec.
- `catalog.query_log` will contain PII inside stored SQL and result summaries.
  It needs a retention period. Propose 180 days; confirm with Fede.
- The login allowlist (`fede`, `soren` only) is now a privacy control, not just
  a convenience. Do not let the wiki's "every active member gets a role" pattern
  through.

---

## 7b. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Which FareHarbor reports does Fede download | **Answered from code.** Three: bookings (detailed), sales, customers. Column signatures in `brain/server.js` `sniffReport()`. Confirm nothing has been added since |
| 2 | Can the report export be reached from the scraper session | **Unresolved.** Assessment in the phase 0 report. Needs one read-only probe. Now higher priority: phase 5 is where the lost history comes back |
| 3 | Exact fleet SQLite path | **Answered.** `/var/www/becopenhagen-fleet/data/fleet.db` |
| 4 | Real assertion bounds | **Answered.** 104 active bikes today. Capacity comes from FareHarbor per departure, see section 7. The `pax <= capacity` assertion must be `warn`, not `block`: Fede overbooks private tours deliberately when a group emails |
| 5 | Booking date or departure date canonical | **Needs Fede.** Both columns exist, one is 40% NULL. With bc-brain retired, departure date is the only one that works until phase 5 |
| 6 | PII policy | **Answered.** Section 7 above |
| 7 | Confirm repo, subdomain, pm2 names | **Repo confirmed and pushed 2026-08-10.** Port still not allocated |
| 8 | The existing brain | **Answered and decided.** Sections 5 and 7 |
| 9 | Are A3F and H3P still sold | **Answered.** Not retired, just never run yet. Keep active |
| 10 | `catalog.query_log` retention period | **New, from the PII decision.** Proposed 180 days |
| 11 | Whole-VPS backup | **Recommended to Fede 2026-08-10:** turn on Hetzner Cloud Backups (a console checkbox, 20% of server cost). A second VPS solves availability, not backup, and is the wrong tool here. Disk in use is only 6.8 GB of 38 GB, so size is not the obstacle. Note that a VM snapshot of a running WAL SQLite file can be inconsistent, which is why `scripts/backup.sh` uses `sqlite3 .backup` for `fleet.db` and must stay. The VPS backup covers everything that script does not: code, Caddy config, `/etc/environment`, `wiki.db`, and the brain CSVs |

---

## 7c. How the warehouse works

Four scripts, chained by `scripts/refresh.sh`, hourly at **:35**. That minute is
deliberate: the fleet's FareHarbor scraper runs at `:00` and holds a write lock
on `fleet.db`, and the wiki curator runs at `:20`.

| Script | Does |
|---|---|
| `snapshot-fleet.sh` | `sqlite3 .backup` of the live fleet DB, verified, then swapped in atomically |
| `archive-logs.sh` | Appends new log rows to Parquet. The only defence against the 120 day retention |
| `build-warehouse.sh` | Runs `sql/build-warehouse.sql`, verifies, swaps in atomically |
| `verify-warehouse.sh` | Cross-checks 22 figures against the LIVE fleet DB. Run after any view change |

Whole chain takes about 3 seconds.

### Three design decisions worth not re-litigating

**Materialised tables, not views over the attached SQLite file.** DuckDB permits
one writer per file, so an hourly in-place rebuild would collide with any
read-only query the app is running. Everything is built into a temp file and
`mv`'d into place, so a reader gets either the whole old warehouse or the whole
new one. The same atomic-swap pattern guards the snapshot.

**The snapshot is converted to `journal_mode=DELETE`.** The `.backup` copy
inherits WAL from the source, and a WAL-mode SQLite file needs its reader to be
able to create a `-shm` sidecar, which DuckDB attaching `READ_ONLY` cannot. This
write is to our own copy, never to `fleet.db`, which is still WAL and verified
`ok` after every run.

**The archive keys off autoincrement id and re-derives its high-water mark from
the Parquet itself.** No state file to drift. Running it twice is a no-op, and a
lost part file self-heals on the next run rather than corrupting the archive.

### What compression bought

`tour_change_log` is 450 MB in SQLite and **3.2 MB as zstd Parquet**, about 140x,
because the data is overwhelmingly the same phantom value relogged every 90
seconds by the known fleet bug. The projected growth of "save everything" drops
from roughly 11 GB a year to well under 100 MB. The disk objection to Fede's
"save all data" decision is gone.

### The bc.* tables

`departures`, `rental_slots`, `bookings`, `departure_bikes`, `guide_hours`,
`guide_reviews`, `fleet_bikes`, `repairs`, `team`, `products`,
`departure_capacity`, `booking_pace`, `data_freshness`.

`bc.booking_pace` is the one that did not exist before: every real movement in a
departure's pax, with `days_before_departure`. It is reconstructed from the
archived change log, collapsing 283,928 raw log rows down to actual changes, and
it is the only way to answer "how far ahead do people book". It only exists
because the archive exists.

### Capacity, as actually found in FareHarbor

Harvested per departure from the payloads bc-fleet's scraper writes to
`tour_change_log.raw_data` and then forgets. 432 departures carry a real
FareHarbor number, 708 fall back to Fede's stated default, 5 are CUSTOM and get
none. Two traps, both confirmed on 2026-08-10:

- `raw_data` is capped at 4000 characters, so many payloads are truncated
  mid-JSON. **Regex-scan it, never JSON-parse it.**
- **`"capacity": null` is common and does not mean zero.** On L2P, L3P, F3P and
  H3P it is null on *every* departure: no seat limit is configured at all.
  Do **not** substitute `bookable_capacity`, which is derived from free BIKES,
  not seats, and reaches 74 on L2P. It would be a catastrophic fill-rate
  denominator.

`fill_rate` is therefore deliberately NULL, not a guess, on CUSTOM (no limit)
and on unsold private slots (open capacity, not an empty departure). The
`pax <= capacity` assertion must be `warn`, never `block`: Fede overbooks
privates on request.

---

## 7d. The catalog

`/var/lib/bc-data/catalog_store.duckdb`. **Not** named `catalog.duckdb`: DuckDB
names the database after the file, which collides with a schema also called
`catalog` and makes every reference ambiguous.

It is a SEPARATE FILE from the warehouse on purpose. The warehouse is dropped
and rebuilt every hour; anything hand-written in it would be destroyed on the
next tick. The catalog holds exactly what must survive: agreed definitions,
recorded mistakes, and every question ever asked.

| Table | Rows | What it is |
|---|---|---|
| `sources` | 15 | One per `bc.*` table, with the `gotchas` that stop wrong answers |
| `definitions` | 23 | The business dictionary, injected into the prompt on every call |
| `columns` | 43 of ~130 | LLM-drafted descriptions, all `reviewed_by IS NULL` |
| `canonical_queries` | 20 | Drafted, all `verified_by IS NULL` until phase 4 |
| `assertions` | 16 | 6 block, 10 warn. Bounds measured, not guessed |
| `limits` | 8 | Inferential traps, checked before any causal sentence |
| `gaps` | 9 | The data roadmap, ranked by citation once the agent runs |
| `corrections` | 9 | **What Fede says back.** See below |
| `query_log` | 0 | Phase 3 fills it. Kept FOREVER |
| `statbank_tables` | 0 | Phase 6 |
| `settings` | 2 | Both retentions set to `forever` |

### `catalog.corrections`, and why it may be the most valuable table here

Fede, 2026-08-10: *"the info I provide in the chat, in response to a response,
should be kept as valuable info, maybe it's an important correction about
assumptions."*

He is right. When someone reads an answer and replies *"no, private tours can go
above 16 if they email us"*, that sentence is worth more than the answer was. It
exists nowhere in FareHarbor, nowhere in the fleet database, and nowhere in this
catalog until somebody writes it down. Before this table, every such sentence
died when the chat window closed.

Seeded with nine things Fede said across phases 0 to 2, eight already applied
into gotchas, definitions, assertions or code. `status` tracks the loop
(`new` to `applied`), and `verify-catalog.sh` fails if an applied correction
does not record where it landed, so nothing can sit captured-but-ignored.

From phase 3 the Ask page writes here whenever either user replies to an answer.

**Retention is `forever`** for both this table and `query_log`, per the same
instruction. The earlier 180 day proposal is withdrawn. A wrong assumption
corrected in 2026 is still corrected in 2029.

### Cost policy: build on the subscription, run on the API

Fede, 2026-08-10: build-time LLM work uses his Claude Max 20x subscription (me,
in a Claude Code session); the API key is reserved for the shipped product, the
queries he and Søren run daily.

This surfaced badly: `bootstrap-columns.js` called the API directly and drained
the balance to zero halfway through, blocking the build. It now **refuses to
call the API without an explicit `--api` flag**. The default path is
`--dump` (write schema, counts and real samples to JSON, no cost) then
`--import` (load descriptions drafted in a session). All 130 columns were
documented this way for nothing.

The rule generalises: never write a build script that spends the product's
balance on work I could do inline.

Seeds are split across four SQL files so re-running one never clobbers another:
`catalog-schema.sql` (idempotent DDL), `catalog-seed.sql` (sources, limits,
gaps), `catalog-definitions.sql` (the dictionary Fede edits), and
`catalog-assertions.sql` / `catalog-canonical.sql`.

### Assertion bounds are measured, and the spec's were wrong

Every bound was recomputed against real data; `bounds_source` records `measured`
or `stated_by_fede`, and `verify-catalog.sh` fails if anything is still
`guessed`. Three of the spec's proposed bounds were off by enough to be useless:

| Spec proposed | Reality | Now |
|---|---|---|
| No departure before 2019-01-01 | Data starts 2026-06-28 | 2026-06-28, and it fires |
| Monthly pax 0 to 5000 | Busiest month is 294 | 2000, about 7x headroom |
| Revenue per booking 0 to 50000 DKK | Max observed 19,300 | 25000 |

`pax_within_capacity` is a **warn**, never a block, because Fede overbooks
private tours on request. An assertion that fires on correct business practice
trains people to ignore assertions.

### The July hole, and why it is the most important thing in the catalog

Departure rows dated before **2026-08-03** all read `pax = 0`, and it is false.
The `bookings` ledger holds 180 tour bookings for July, and **179 of those 180
point at an `availability_id` that no longer exists** in `tour_availabilities`.
The departure rows for tours that actually sold were deleted from the live fleet
database; what survives for July is mostly private slots that never sold.

Unhandled, "how did July go" answers **"93 departures, 0 passengers, 0% full"**
with total confidence. That is the worst answer this tool could produce, and it
is precisely the failure mode the whole project exists to prevent.

Three layers now stop it: `bc.departures.pax_is_reliable`, a `block` assertion,
and the `history_starts_june_2026` limit rule.

`bc.departures_recovered` reconstructs the deleted departures from the archive
(375 July departures, 332 pax, versus 93 and 0 in the live database). It is
deliberately NOT merged into `bc.departures`: measured against August, where the
live data is ground truth, it over-counts pax by **43%**, because FareHarbor
reissues availability IDs and deduping needs a `start_time` the change log never
recorded. Trading a visible hole for an invisible inflation is a much worse deal.

### Verification

`scripts/verify.sh` runs all four suites: warehouse vs the live fleet database,
data assertions, every canonical query executed, and catalog integrity. Run it
after ANY change to the SQL or the catalog. All green as of 2026-08-10.

`run-assertions.sh` and `update-catalog-stats.sh` are also wired into the hourly
`refresh.sh`, so a bad build is caught at build time rather than in an answer.

---

## 8. Phase status

| Phase | Status |
|---|---|
| 0. Read and report | **Done 2026-08-10** |
| 1. Warehouse | **Done 2026-08-10.** Live, hourly, 22/22 verification checks passing |
| 2. Catalog | **Done 2026-08-10.** 130 columns documented, 23 definitions, 17 assertions |
| 3. Agent and Ask page | **Built 2026-08-10.** Live under pm2 on port 4200. BLOCKED on DNS and API credit, see below |
| 2. Catalog | Not started |
| 3. Agent and Ask page | Not started |
| 4. Audit session with Fede | Not started. Blocks phase 5 |
| 5. Sources page and alerting | Not started |
| 6. Statbank | Not started |
| 7. Dictionary and Gaps pages | Not started |

---

## 9. Session log

Newest entry on top.

### 2026-08-10, Phase 3: the tool exists, and guide names get resolved properly

The app is built and running under pm2 as `bc-data` on port 4200. Express,
shared fleet login restricted to `fede` and `soren`, Ask page with streaming,
collapsed SQL, freshness chips, glossary hover, and the Sources, Dictionary and
Gaps pages read-only for now.

**Two things block Fede using it**, neither of which I can fix from here:

1. **DNS.** `data.becopenhagen.dk` resolves to 94.231.103.180, not this VPS
   (178.104.12.40). Caddy is configured and validated, and will pick up a
   certificate automatically the moment the A record points here. Until then it
   retries ACME every 60 seconds and fails.
2. **Anthropic API credit.** Runtime queries are billed to the API by Fede's own
   cost policy, and the balance is zero. The app returns a plain "the account
   has no credit" message rather than a stack trace.

**Guide names, after Fede's correction.** He said: "there is a reason why we had
lots of different spelling, there is manual input in some parts of the system and
we get spelling wrong but the system should still catch it. We don't build naive
systems." So `scripts/resolve-guides.js` ports the fleet's own matcher (accents,
aliases, Levenshtein, word-level) and builds `bc.guide_identity`, mapping every
spelling to one `member_id`. Nine spellings resolve to eight people. Paloma and
Féidhlim would both have been lost on a naive name join.

`scripts/test-guide-matching.js` proves it against the live team table: 31 cases
including `Fedrico`, `monika`, `Ibrahmi`, `andrw`, `Dimitraa`, `Hasse Sørensen`,
and six pairs that must NEVER merge, because putting one guide's hours on another
guide's invoice is worse than failing to match at all.

**A design mistake his question exposed.** My first version exited non-zero on an
unresolved name, which would have let one typo in a hand-typed crew note freeze
the entire hourly refresh for everyone. It is now a loud warning plus the
`unresolved_guide_names` assertion: the data keeps flowing and the odd name is
impossible to miss. Availability beats purity when the input is human.

**Also fixed, both caught by the checks rather than by me:**

- `catalog-seed.sql` was not idempotent once a gap had been cited. Its
  `DELETE WHERE cited_count = 0` left cited gaps in place and then hit a primary
  key violation, aborting the whole seed. Now an upsert that preserves
  `cited_count`, because that count is earned at runtime and ranks the roadmap.
- The seed still carried the old 180 day query-log retention and silently
  reverted Fede's "forever" every time it ran. Removed. **A seed file must never
  be able to overwrite a decision a person made**, and the
  "history is kept forever" check is what caught it.

Verification is now 115 checks across six suites, all green, including 18 that
prove the agent's safety without spending a cent: `run_sql` refuses CREATE, DROP,
UPDATE, DELETE and ATTACH at the connection level; the fleet database is
unreachable by name; the row cap and timeout hold; and **the July trap is
BLOCKED with the numbers withheld**, while the same question asked properly still
answers.

### 2026-08-10, Phase 2b: corrections are data, and a time column with two formats

Fede corrected two things, both of which changed the build.

**Cost.** Build work runs on his Max subscription, the API key is for the
shipped product. `bootstrap-columns.js` had been calling the API directly and
drained the balance to zero. Restructured to `--dump` / `--import`, with `--api`
now opt-in and refused by default. All 130 columns are documented, at no cost,
and the 9 tables blocked yesterday are done.

**History is kept forever**, and, more interestingly, so is what he says in
chat. That produced `catalog.corrections`, seeded with nine things he has told
me across phases 0 to 2, eight already applied into the catalog. Section 7d
argues why this is close to the most valuable table in the system. The 180 day
query-log retention proposal is withdrawn.

**Found while reading real samples to write the column docs:** `start_time`
holds TWO formats in one column. The hourly scraper writes `10.00` (Danish
locale) and the 90-second iCal sync writes `10:00`, currently 1061 rows against
81. So `WHERE start_time = '10:00'` silently returned 7% of the departures it
should. Normalised to `HH:MM` in `bc.departures` and `bc.rental_slots`, with
`start_time_raw` kept for tracing. This is exactly what the clean layer is for,
and it would never have been caught by looking at the schema: only at the values.

Also recorded from the samples: `fleet_bikes.return_due` is NULL on every single
row (a dead column, nothing should be built on it), no repair ticket has been
logged since 2026-07-14 (the feature stopped being used, which must not be read
as nothing breaking), `departures_recovered` mixes rentals in with tours, and
guide names do not match team names anywhere (`Federico Tortonese` versus
`Federico`, `Pam` versus `Paloma`), so joining on name loses guides.

Verification is now 65 checks across four suites, all green.

### 2026-08-10, Phase 2: the catalog, and the July hole

Catalog built: 15 sources with gotchas, 23 definitions, 16 assertions, 8 limits,
9 gaps, 20 canonical queries all executed against the real warehouse. Mechanics
in section 7d. `scripts/verify.sh` runs all four suites and is green.

**The finding that justifies the whole project.** While computing real assertion
bounds I noticed July reporting 93 departures and zero passengers. It is not
true: 179 of 180 July tour bookings point at a departure row that has been
deleted from the live fleet database. Asked "how did July go", the tool would
have answered "0 passengers, 0% full" with complete confidence. That is exactly
the confident wrong answer the spec was written to prevent, and it was three
days of work away from being the first thing Fede ever asked it.

It is now blocked three ways: a `pax_is_reliable` column, a `block` assertion,
and a limit rule. And the archive built in phase 1 turned out to hold the
deleted departures: 375 of them for July carrying 332 pax. That reconstruction
is exposed as `bc.departures_recovered` and deliberately kept OUT of
`bc.departures`, because measured against August it over-counts by 43% thanks to
FareHarbor reissuing availability IDs. A visible hole beats an invisible
inflation.

**Blocked on Fede:** the Anthropic API account hit a zero credit balance partway
through the column-description pass. 5 tables of 14 completed (43 columns), 9
failed. `bootstrap-columns.js --only-missing` finishes the rest for well under a
dollar once there is credit. Nothing else in the project depends on it.

Two bugs of mine, both in verification code, both found because the checks were
themselves checked: `'\t'` in a DuckDB string literal is a literal backslash-t,
not a tab, which made `run-assertions.sh` report "0 assertions" while exiting
successfully; and `information_schema` is scoped to the current database and is
unreachable through an ATTACH alias, so the cross-file check needed
`duckdb_tables()`. Both had the same shape as the phase 1 archive bug: a check
that silently passes because it never ran. That is now the thing to look for
first in this codebase.

### 2026-08-10, Phase 1: the warehouse is live

Built and running. `refresh.sh` chains snapshot, archive and rebuild hourly at
`:35`, takes about 3 seconds, and `verify-warehouse.sh` cross-checks 22 figures
against the live fleet database: all pass, including gross DKK matching to the
krone (952,589) with zero money-parse failures. Mechanics in section 7c.

Two things came out better than expected.

**Compression settles the disk question.** `tour_change_log` is 450 MB in SQLite
and 3.2 MB as zstd Parquet. "Save all data" now costs well under 100 MB a year
instead of the ~11 GB I warned about, so Fede's decision to leave the fleet app
alone carries no real storage penalty.

**Booking pace turned out to be recoverable.** The archived change log records
every movement in a departure's pax with a timestamp, so `bc.booking_pace`
reconstructs how bookings accumulated in the run-up to each departure, with
`days_before_departure`. That question was not answerable from any table in the
fleet database directly. It exists only because the archive exists, and it would
have started disappearing on 2026-10-26.

Confirmed unharmed after every run: `fleet.db` still WAL, `PRAGMA quick_check`
returns `ok`, bc-fleet answering HTTP 200, all three pm2 apps online. The
crontab was backed up before editing and all five pre-existing lines are intact.

Four bugs found and fixed while building, all mine. Two trivial: `.backup`
cannot share a `sqlite3` argument with a `PRAGMA` (it is a dot-command, not
SQL), and `COALESCE(resolved_at, now())` mixes VARCHAR with TIMESTAMPTZ so the
DATE cast has to happen on both sides first.

The other two would have been serious, and both were found by running the chain
under a simulated cron environment rather than trusting that it worked:

**`duckdb` lives in `/usr/local/bin`, which is not on cron's PATH.** Everything
passed by hand and would have failed the moment cron ran it. Every script now
sets PATH explicitly and checks `command -v duckdb` up front.

**The archive swallowed that failure and reported success.** `N=$(duckdb ... 2>/dev/null | tail -1)`
with `N=${N:-0}` turned "duckdb did not run" into "0 new rows", exit 0, against
the one deadline that matters. Worse, the same defaulting on the high-water-mark
read would have reset it to 0 and re-copied the entire table into a new part
file, duplicating the archive. Both now abort loudly with a non-zero exit, and
the row count and high-water mark are validated as integers before use.
Verified after the fixes: 284,088 archived rows, 284,088 distinct ids.

The lesson worth keeping: a backup or archive job that cannot fail loudly is
worse than no archive at all, because it removes the reason to check.

Not done, deliberately: nothing was deleted, bc-brain is still running, and the
fleet app was not touched.

### 2026-08-10, capacity turns out to be free

Fede supplied capacities (12, F3 10, private 16 soft, CUSTOM unlimited) and
asked whether the tool needs a settings page for data like this, or could
auto-update. Checked before answering, and the answer is better than either:
**FareHarbor publishes `capacity` on every availability, the fleet scraper
already fetches it and throws it away.** Its numbers match Fede's exactly across
92 sampled departures. So capacity is captured per departure rather than
hand-maintained per product, which also handles the two awkward cases he raised
(overbooking a private group on request, CUSTOM having no limit) with no
settings page at all. Detail and the harvest plan in section 7.

The general lesson for the rest of this build: before adding a settings page for
a number, check whether FareHarbor already knows it. A settings page is a
standing invitation for the tool's numbers to drift from reality.

### 2026-08-10, Phase 0 decisions: retire the brain, archive the logs, allow PII

First commit pushed (`f24748e`). Fede then took the three blocking decisions,
recorded in full in section 7 and summarised here.

**bc-brain is retired and its `analytics.db` will not be ported.** His reasoning
was that the data lives elsewhere, and that is right: `analytics.db` was only
ever derived from three FareHarbor CSV exports, which FareHarbor can reissue and
which are still on disk at `brain/uploads/`. The cost is real but bounded: until
phase 5 loads those exports into the clean warehouse, bc-data sees back to
2026-06-28 only, so no year-on-year and no season comparison. This raises the
priority of the §4.2 FareHarbor export investigation, since phase 5 is now the
route by which the history returns rather than a convenience.

Found while checking that claim: `scripts/backup.sh` covers `fleet.db` only.
Neither `analytics.db` nor the source CSVs are in any backup, and `brain` gitignores
both. Flagged to Fede; not acted on, because this session is read-and-report.

**The fleet app must not be touched**, so the phantom-logging bug stays and
bc-data becomes the permanent log archive instead. Hard deadline 2026-10-26,
which is 120 days after the oldest surviving row. Storing the archive as
compressed Parquet rather than raw is what keeps "save all data" inside the disk
budget: roughly 11 GB a year raw, under 1 GB compressed, on 29 GB free.

**PII is allowed on request**, aggregate by default. So `is_pii` becomes a label
rather than a block, `catalog.query_log` needs a retention period (180 days
proposed), and the two-user login allowlist is now a privacy control.

Still blocking phase 1: the `bc.products` capacity table, which exists in no
database and which every fill-rate number depends on.

### 2026-08-10, Phase 0: repo bootstrap, and the history that is not in fleet.db

Initialised the repo and committed `spec_data.md` alongside this file. No
application code, no DuckDB file, no views: phase 0 is read and report only.

Read the bc-fleet repo, its `CLAUDE_CONTEXT.md` and the live SQLite schema; the
bc-wiki app for the shared-login pattern; and the v2 FareHarbor scraper.

The finding that changes the plan: **fleet.db starts on 2026-06-28**, six weeks
of data. The spec assumes years. Meanwhile `bc-fleet/brain/analytics.db` holds
3217 bookings and 3602 sales events back to December 2022, loaded by hand from
three FareHarbor CSV exports, and `bc-brain` already runs a Claude Q&A and a
weekly analyst briefing over them. So the long history exists, but not where the
spec expects it, and a large part of the product already exists.

Also recorded: the two-writer ownership rules, the 120 day log retention window
that caps any audit-derived view, `bookings.total` being TEXT `DKK1,200.00`,
`bookings` having no cancellation flag at all, `booking_created_at` NULL on 40%
of rows, and `booking_count` meaning pax on tours but reservations on rentals.

Git remote uses the credential store already configured on this box
(`credential.helper=store`, user `tortonesef-coder`) rather than a token
embedded in `.git/config`, so the token is not written into the repo.
