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

**Open decision for Fede:** bc-data either absorbs bc-brain (its analytics.db
becomes a `bc.*` source, its context.md becomes `catalog.definitions` and
`catalog.limits`, bc-brain is retired) or the two run side by side answering the
same questions differently. Building bc-data without deciding this produces two
tools that disagree, which is precisely what `catalog.definitions` exists to
prevent.

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

## 7. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Which FareHarbor reports does Fede download | **Answered from code.** Three: bookings (detailed), sales, customers. Column signatures in `brain/server.js` `sniffReport()`. Confirm nothing has been added since |
| 2 | Can the report export be reached from the scraper session | **Unresolved.** Assessment in the phase 0 report. Needs one read-only probe |
| 3 | Exact fleet SQLite path | **Answered.** `/var/www/becopenhagen-fleet/data/fleet.db` |
| 4 | Real assertion bounds | **Partly answered.** 104 active bikes today; per-tour capacity still needs Fede |
| 5 | Booking date or departure date canonical | **Needs Fede.** Both columns exist, one is 40% NULL |
| 6 | PII policy | **Needs Fede.** Fleet `bookings` holds name, email and phone on every row |
| 7 | Confirm repo, subdomain, pm2 names | **Needs Fede.** Port not yet allocated |
| 8 | The existing brain | **Answered.** Section 5. The real question is now absorb or coexist |

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
