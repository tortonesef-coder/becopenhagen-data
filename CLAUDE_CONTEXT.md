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
| pm2 process | `bc-data` (not created yet) |
| Subdomain | `data.becopenhagen.dk` (not in Caddy yet) |
| Data directory | `/var/lib/bc-data/` (not created yet) |
| Port | to allocate. 3456 is bc-fleet, 4100 is bc-wiki, 3000 is the Life OS router |

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
| `router`, `list` | Life OS, unrelated | 3000 | Do not touch |

### Cron on this box

```
0  *  * * *  bc-fleet FareHarbor guide-schedule scraper (v2)
20 *  * * *  bc-wiki curator
0  6  * * 1  bc-brain weekly analyst briefing
0  3  * * *  bc-fleet nightly backup
30 3  * * *  bc-fleet backup watchdog
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

## 8. Phase status

| Phase | Status |
|---|---|
| 0. Read and report | **Done 2026-08-10.** Awaiting approval |
| 1. Warehouse | Not started. Blocked on approval |
| 2. Catalog | Not started |
| 3. Agent and Ask page | Not started |
| 4. Audit session with Fede | Not started. Blocks phase 5 |
| 5. Sources page and alerting | Not started |
| 6. Statbank | Not started |
| 7. Dictionary and Gaps pages | Not started |

---

## 9. Session log

Newest entry on top.

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
