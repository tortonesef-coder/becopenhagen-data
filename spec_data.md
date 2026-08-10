# SPEC.md

## BeCopenhagen Data (working name: bc-data)

A natural-language query tool over BeCopenhagen's operational data plus Danmarks Statistik, built for two non-technical users.

Status: build specification. Nothing exists yet. Read section 12 before starting.

---

## 0. Purpose and non-goals

### Purpose

Fede and Søren ask business questions in plain English and get answers grounded in real data, without writing SQL and without either of them auditing queries after the initial build.

The tool is used ad hoc. There is no fixed report, no dashboard, no scheduled output. It sits idle for a week and then gets ten questions in an afternoon.

### The tool must be sceptical, not confident

This is the defining behavioural requirement and it drives several design choices below. The tool should:

* say what it cannot know from the data it has
* name the alternative explanations when a finding is ambiguous
* volunteer what additional data would sharpen the answer
* refuse to produce a causal-sounding sentence that the data cannot support

A confident wrong answer is the primary failure mode of this system. Everything in section 6 exists to prevent it.

### Non-goals

* Not a dashboard or BI tool. No saved charts, no scheduled reports.
* Not a wiki. The internal wiki at wiki.becopenhagen.dk is a separate system and this must not be built inside it or depend on it.
* Not a writer. Read-only against every source, always. It never writes to FareHarbor, to bc-fleet, or to any Excel model.
* Not a replacement for the 2027 business plan model. It informs that model, it does not become it.
* Not multi-tenant. Two users.

---

## 1. Environment

The VPS already runs:

* `becopenhagen-fleet` (repo `tortonesef-coder/becopenhagen-fleet`, pm2 process `bc-fleet`, at `app.becopenhagen.dk`). Node.js + Express + SQLite + vanilla JS PWA.
* The internal wiki at `wiki.becopenhagen.dk`, a separate app on its own pm2 process, which reads the fleet SQLite database read-only. **This is the precedent to follow.**
* A Life OS router, unrelated to this project.

### This app

| Item | Value |
|---|---|
| Repo | `tortonesef-coder/becopenhagen-data` |
| Path | `/var/www/becopenhagen-data` |
| pm2 process | `bc-data` |
| Subdomain | `data.becopenhagen.dk` |
| Data directory | `/var/lib/bc-data/` |

Deploy line, to be used at the end of every push:

`cd /var/www/becopenhagen-data && git pull && pm2 restart bc-data --update-env`

Maintain `CLAUDE_CONTEXT.md` in this repo as a living document, updated in every commit, same convention as bc-fleet.

---

## 2. Architecture

```
  SOURCES              INGESTION            WAREHOUSE          AGENT          UI
  ---------            ---------            ---------          -----          --
  fleet SQLite   -->   hourly .backup  -->  DuckDB        -->  Claude    -->  Ask
  FareHarbor     -->   scraper or           (read-only         + tools        Sources
    reports            manual upload         attach +                         Dictionary
  api.statbank.dk -->  on-demand pull        parquet)                         Gaps
                                                ^
                                            catalog.*
```

### Storage

A single DuckDB file at `/var/lib/bc-data/warehouse.duckdb`.

DuckDB rather than SQLite (which the rest of the stack uses) for one specific reason: Statbank produces many wide, time-series-shaped tables, and DuckDB reads a growing directory of Parquet files with no per-table schema work. SQLite would require a hand-written table definition per series.

### Schemas

| Schema | Contents |
|---|---|
| `bc` | Views over BeCopenhagen operational data (fleet snapshot, FareHarbor reports) |
| `dst` | Statbank tables, one view per pulled table |
| `catalog` | All metadata, definitions, assertions, logs |

### Fleet data access

Do **not** attach the live fleet SQLite file. Instead, hourly cron:

```bash
sqlite3 /path/to/fleet.db ".backup /var/lib/bc-data/snapshots/fleet.db"
```

`.backup` is safe against a live database. DuckDB then attaches the snapshot read-only:

```sql
INSTALL sqlite; LOAD sqlite;
ATTACH '/var/lib/bc-data/snapshots/fleet.db' AS fleet_raw (TYPE SQLITE, READ_ONLY);
```

This removes all concurrency risk against the running app, and gives a meaningful `_loaded_at` timestamp. Fleet data being up to one hour stale is acceptable for ad-hoc analysis and is always displayed.

The `bc.*` views sit on top of `fleet_raw`, renaming and cleaning as needed. The agent only ever sees `bc.*`, never `fleet_raw`.

### Parquet landing

`/var/lib/bc-data/raw/{source_key}/{yyyy-mm-dd}/*.parquet`

---

## 3. Data model: the catalog

The catalog is the actual product. The warehouse is plumbing.

### 3.1 `catalog.sources`

```sql
CREATE TABLE catalog.sources (
  source_key             VARCHAR PRIMARY KEY,
  display_name           VARCHAR,
  schema_name            VARCHAR,
  layer                  VARCHAR,      -- raw | view | external
  description            TEXT,         -- what it is, plain English
  grain                  TEXT,         -- 'one row per booking per pax'
  refresh_cadence_hours  INTEGER,
  retrieval_method       VARCHAR,      -- auto | manual
  retrieval_instructions TEXT,         -- exact steps to refresh by hand
  gotchas                TEXT,         -- see below
  last_loaded_at         TIMESTAMP,
  last_row_count         BIGINT,
  prev_row_count         BIGINT,
  max_date_in_data       DATE,
  owner                  VARCHAR
);
```

`gotchas` is the highest-value column in the system. Every time the tool produces a wrong answer, the correction is written here and it never repeats the mistake. Examples of the kind of content expected:

* bookings include cancelled records, filter on status
* revenue is gross of OTA commission
* the guide schedule scrape covers departures only, not bookings

### 3.2 `catalog.columns`

```sql
CREATE TABLE catalog.columns (
  schema_name  VARCHAR,
  table_name   VARCHAR,
  column_name  VARCHAR,
  data_type    VARCHAR,
  description  TEXT,
  gotcha       TEXT,
  sample_values TEXT,
  is_pii       BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (schema_name, table_name, column_name)
);
```

Bootstrap `description` with a one-off LLM pass over column names plus twenty sample values per column. Fede reviews and corrects. Do not hand-write these from scratch and do not ship them unreviewed.

### 3.3 `catalog.definitions` (the business dictionary)

```sql
CREATE TABLE catalog.definitions (
  term        VARCHAR PRIMARY KEY,
  definition  TEXT,      -- plain English
  sql_snippet TEXT,      -- the canonical expression
  do_not_use  TEXT,      -- the plausible-but-wrong alternative
  updated_at  TIMESTAMP,
  updated_by  VARCHAR
);
```

This exists because two people are querying the same data. Without it, Fede and Søren get different numbers for the same question and both are defensible SQL.

Seed with roughly twenty terms covering the whole business vocabulary: tour, departure, booking, pax, occupancy, fill rate, sellout, active bike, guide hour, revenue, channel, private tour, no-show, cancellation.

**Mandatory first entry.** The booking-date versus departure-date distinction. "How many pax in July" has two defensible answers and the model will silently pick one. Define which is canonical, and define the term for the other.

The full definitions table is injected into the system prompt on every call. It is small and it is load-bearing.

### 3.4 `catalog.canonical_queries`

```sql
CREATE TABLE catalog.canonical_queries (
  query_key       VARCHAR PRIMARY KEY,
  question_pattern TEXT,     -- natural language, for matching
  sql             TEXT,
  notes           TEXT,
  verified_by     VARCHAR,
  verified_at     TIMESTAMP
);
```

Roughly twenty entries covering the recurring questions: pax by month, fill rate by product, bikes out on a date, revenue by channel, guide hours by person, occupancy by tour code, season over season comparison.

These are hand-verified once, with Fede, in a single session (section 11, phase 4). After that they are trusted. The agent must call `find_canonical_query` before writing fresh SQL and must use a strong match verbatim rather than composing its own.

### 3.5 `catalog.assertions`

```sql
CREATE TABLE catalog.assertions (
  assertion_key VARCHAR PRIMARY KEY,
  target        VARCHAR,   -- schema.table or '*' for result-level
  expression    TEXT,      -- SQL boolean, must evaluate TRUE
  message       TEXT,      -- what it means when it fails
  severity      VARCHAR    -- block | warn
);
```

Run on every load and on every query result. These are deterministic and they are the real safety layer.

Starting set, **bounds to be confirmed by Fede against real numbers**:

| Check | Rough bound |
|---|---|
| No departure before company start | `>= 2019-01-01` |
| Occupancy is a proportion | `BETWEEN 0 AND 1` |
| Pax per departure within capacity | `<= max capacity for tour code` |
| Bikes out never exceeds fleet | `<= total fleet size on that date` |
| Monthly pax plausible | `BETWEEN 0 AND 5000` |
| Revenue per booking plausible | `BETWEEN 0 AND 50000 DKK` |

A `block` failure means the agent reports the violation instead of the number. It must never silently return a figure that failed an assertion.

### 3.6 `catalog.gaps` (scientist mode, part one)

```sql
CREATE TABLE catalog.gaps (
  gap_key     VARCHAR PRIMARY KEY,
  missing     TEXT,     -- 'guide hours by tour code'
  unlocks     TEXT,     -- 'contribution margin per product'
  how_to_get  TEXT,     -- 'payroll export tagged by tour code'
  effort      VARCHAR,  -- low | medium | high
  cited_count INTEGER DEFAULT 0
);
```

After answering, the agent checks whether any gap is relevant to the question just asked. If so it names **exactly one**, in a single sentence, and calls `log_gap_hit`. Never a list. If every answer ends with a wishlist, the user stops reading them.

`cited_count` makes the gaps rank themselves, which turns this table into the data roadmap.

Seed gaps, given the v1 scope excludes accounting: guide cost per tour, OTA commission by channel, fleet maintenance cost, marketing spend by channel, weather at departure time.

### 3.7 `catalog.limits` (scientist mode, part two)

```sql
CREATE TABLE catalog.limits (
  limit_key   VARCHAR PRIMARY KEY,
  rule        TEXT,     -- injected into the system prompt
  applies_to  TEXT      -- free text hint
);
```

Inferential rules the agent must check before committing to any causal-sounding sentence. It is a table rather than hard-coded prompt text so Fede can add to it without a code change.

Seed with these five, which are the specific traps in this business:

1. **Supply mistaken for demand.** Four departures with low fill is not a measurement of demand. It is a measurement of what was scheduled. Always check whether departures existed before concluding anything about appetite.
2. **Small n.** A fill rate across fewer than roughly fifteen departures is noise. Say so rather than reporting it as a rate.
3. **Review survivorship.** A 50 DKK bonus is paid per five-star review, which biases the sample twice. Review counts are not a satisfaction measure.
4. **Channel selection.** GYG, Viator and Airbnb customers are different populations. Pooling them hides the thing worth knowing. Segment or flag.
5. **Seasonality read as trend.** Month-over-month movement in this business is mostly weather and calendar. Compare like months across years, not adjacent months.

### 3.8 `catalog.statbank_tables`

Local mirror of the DST table list for search. Columns: `table_id`, `title_en`, `title_da`, `subject_path`, `variables` (JSON), `first_period`, `latest_period`, `dst_updated`. Refresh monthly.

### 3.9 `catalog.query_log`

Every question, the SQL run, a result summary, timestamp, user, assertions triggered, gap cited, latency, token cost.

This is how you find out later that a number was wrong, and it is how recurring gaps and missing definitions surface. It is not optional.

---

## 4. Sources for v1

Only three. Accounting and OTA exports are explicitly out of scope for v1.

### 4.1 bc-fleet (auto, hourly)

Snapshot and attach as in section 2. Claude Code must read the actual fleet schema in phase 0 and report it before any views are written.

### 4.2 FareHarbor reports

**Investigate automation before building the manual path.** The existing v2 scraper in bc-fleet holds an authenticated session against FareHarbor's internal API. Report exports are likely reachable from that same session as a URL with query parameters. If this works, the highest-rot source in the system becomes the most reliable one.

Build the manual upload path regardless, as the fallback: a drop zone on the Sources page, CSV in, Parquet out, `last_loaded_at` updated, alert cleared.

Before writing the ingestion mapping, confirm with Fede which reports he downloads and what columns they contain. Some of it may already be present in bc-fleet and therefore redundant.

### 4.3 Danmarks Statistik

Base URL `https://api.statbank.dk`. TLS 1.2 or higher required. Four endpoints: `subjects`, `tables`, `tableinfo`, `data`. POST with a JSON body is the preferred form. Returns JSON, JSONSTAT, CSV and other formats.

Licensed CC-BY 4.0 for commercial use **on condition of source attribution**. The UI must display "Source: Danmarks Statistik" wherever DST-derived figures appear. This is a licence condition, not a nicety.

Known quirk to record in `gotchas`: values return in English when requested, but column names stay Danish (`OMRÅDE`, `TID`, `KØN`, `INDHOLD`). Map them once at ingestion.

Flow: `search_statbank(keywords)` searches the local mirror, the agent picks a table, fetches `tableinfo` for variable codes, pulls the data, caches to Parquet, registers a row in `catalog.sources` carrying the DST `updated` timestamp.

### 4.4 The Statbank rule

Statbank is for **comparison and contradiction**, never for arithmetic across schemas.

Allowed and actively wanted: "December looks dead in our bookings, but DST overnight stays show substantial winter traffic in Copenhagen."

Forbidden: computing a ratio across `bc.*` and `dst.*`. "We captured 0.4% of Copenhagen visitors" is a fabricated number because the denominators are not the same population.

When the two sources appear to disagree, the agent must lay out the competing explanations rather than pick one, and then say how to distinguish them. Worked example the agent should be able to reproduce:

> Bookings show near-zero December volume. DST shows meaningful December overnight stays. Three explanations: winter visitors exist but are not bike-tour buyers; no December departures were scheduled so there was nothing to buy; departures ran but nobody knows you operate in winter. To distinguish: check whether December departures were on the calendar at all. Scheduled-and-empty is evidence of low demand. Not-scheduled means there is no evidence either way, and an absence of supply has been read as a finding.

---

## 5. The agent

### Model

Use the most capable Claude model available. Model ID in an environment variable so it can be swapped without a deploy.

### Prompt caching is mandatory

The static context block (business background, definitions, schema summary, limits, gotchas) is byte-identical on every call. It must be sent as a cached prefix. This is an architectural requirement, not an optimisation to add later, because it is the difference between a sustainable and an unsustainable running cost.

### Static context block

1. What BeCopenhagen is: bike tours and rental, Copenhagen, tour codes A3 architecture, L3 liveability, F3 food, H3 history, private variants suffixed P, channels GYG, Viator, Airbnb, direct.
2. The full `catalog.definitions` table.
3. A compact schema summary of `bc.*` and `dst.*` (names, columns, one-line descriptions). Not sample data.
4. All `catalog.limits` rules.
5. Behaviour rules, section 5.2.

### 5.1 Tools

| Tool | Purpose |
|---|---|
| `search_tables(keywords)` | Full-text over `catalog.columns` and `catalog.sources` |
| `describe_table(name)` | Columns, descriptions, gotchas, row count, `_loaded_at` |
| `find_canonical_query(question)` | Search `catalog.canonical_queries`. **Must be called before writing fresh SQL** |
| `run_sql(sql)` | Read-only, 30s timeout, 5000 row cap. Runs assertions on the result |
| `search_statbank(keywords)` | Search the local DST mirror |
| `get_statbank_table(table_id, filters)` | Pull, cache, register |
| `log_gap_hit(gap_key)` | Increment gap citation count |

`run_sql` must be genuinely read-only, enforced at the DuckDB connection level, not by inspecting the SQL string.

### 5.2 Behaviour rules

1. Call `find_canonical_query` first. Use a strong match verbatim.
2. State **data as of** for every source touched, in every answer.
3. Show the SQL, in a collapsed block. Not for auditing, but so that when a number looks wrong in six months the evidence still exists.
4. Check `catalog.limits` before writing any causal-sounding sentence.
5. Triangulate headline numbers: compute a single reported figure a second way. If the two disagree by more than 1%, report both and flag the discrepancy rather than choosing.
6. Never join or compute across `bc.*` and `dst.*`. Compare freely.
7. Cite at most one gap per answer.
8. Aggregate by default. Never surface customer names or emails unless the question is explicitly about an identified customer.
9. If an assertion with `block` severity fails, report the failure instead of the number.
10. Prefer "I cannot tell from this data" over a plausible guess. Scepticism is the requested default.

### 5.3 On self-review

The agent will review its own SQL, and that is worth keeping because it is nearly free. It is **not** the safety layer and must not be described as one in the UI.

A model reviewing its own query catches syntax errors, unit mistakes and absurd magnitudes. It does not catch join fan-out, a filter that silently dropped a year, or the wrong date column, because those look correct to the thing that produced them. Sections 3.4 and 3.5, canonical queries and assertions, are the layers that actually hold.

---

## 6. UI

Four pages. Shared login with bc-fleet, same mechanism the wiki uses.

Read `/mnt/skills/public/frontend-design/SKILL.md` before building the frontend. Visual language should sit alongside bc-fleet rather than clash with it.

### Ask

The main page. Chat, streaming responses.

* Collapsed SQL block under each answer
* "Data as of" chips for every source touched, amber when stale
* Glossary terms auto-linked inline, definition appears on hover. This was an explicit request. Match against `catalog.definitions.term` on render
* At most one gap suggestion per answer, visually distinct from the answer body
* Source attribution line when DST data is used

### Sources

* Table of `catalog.sources` with a green, amber or red freshness indicator
* `last_loaded_at`, row count, delta versus previous load
* `retrieval_instructions` shown inline for manual sources
* Drag-and-drop CSV upload for manual sources

### Dictionary

* Full CRUD over `catalog.definitions`
* Fields: term, definition, canonical SQL, do-not-use note
* Both users can edit. Log who changed what and when

### Gaps

* `catalog.gaps` sorted by `cited_count` descending
* Effort tag visible
* This page is the data roadmap

---

## 7. Alerting

Nightly cron at 07:00 CET. Email to federico@becopenhagen.dk via the same Simply.com SMTP path bc-fleet uses.

Three checks:

1. **Stale**: `last_loaded_at + (refresh_cadence_hours * 1.5 hours) < now()`
2. **Volume drop**: `last_row_count < prev_row_count * 0.8`
3. **Not advancing**: `max_date_in_data` unchanged since the previous load

A source that refreshes on schedule with garbage in it is worse than one that is visibly stale, which is why checks 2 and 3 exist.

The email body includes `retrieval_instructions` verbatim, so the message itself is the fix.

Send a weekly digest on Mondays even when nothing is stale, so that silence is informative rather than ambiguous.

---

## 8. Security and privacy

* Read-only throughout. The DuckDB connection used by `run_sql` is opened read-only. The fleet snapshot is a copy.
* Customer PII is in scope and present. Columns holding it are flagged `is_pii` in `catalog.columns`. The agent aggregates by default (rule 8).
* **Data leaves the box.** Schema, definitions and query result rows are sent to the Anthropic API on every call, and result rows may contain customer data. This is inherent to the design and Fede should decide on it deliberately rather than discover it later. Mitigation available if wanted: block `is_pii` columns from `run_sql` output entirely, so identified rows never enter a prompt.
* `catalog.query_log` may contain PII inside stored SQL and result summaries. Set a retention period.
* Secrets in environment variables. Never committed.

---

## 9. Cost

Billed to the Anthropic API, not covered by a Claude subscription. Prompt caching (section 5) is the main control. Log per-query token counts in `catalog.query_log` so real cost is visible from week one rather than estimated.

---

## 10. What is deliberately not being built

Recorded so it does not get added by reflex:

* dbt. No transformation DAG exists to justify it.
* A vector database over BeCopenhagen tables. There are tens of tables, not tens of thousands. Full-text search over the catalog is sufficient. (The DST mirror is the one place search is genuinely needed, and even there full-text is enough.)
* OpenMetadata, DataHub, Amundsen. Enterprise catalogs solving a coordination problem that does not exist at two users.
* Scheduled reports or dashboards. The stated use is ad hoc.
* Any write path to any source system.
* Accounting and OTA export ingestion. Out of v1 scope by decision, to be revisited before the Fortunstræde scenario rebuild of the 2027 model, because contribution margin needs them.

---

## 11. Build phases

**Phase 0. Read and report.** Read the bc-fleet repo and its SQLite schema. Read the wiki app to copy its auth pattern. Report findings and proposed `bc.*` view definitions. Change nothing. Wait for approval.

**Phase 1. Warehouse.** DuckDB file, hourly fleet snapshot cron, attach, `bc.*` views. Verify against known numbers from the fleet app.

**Phase 2. Catalog.** All tables from section 3. LLM-drafted column descriptions for review. Definitions seeded by hand with Fede.

**Phase 3. Agent and Ask page.** Tools, static context, caching, streaming chat, collapsed SQL, data-as-of chips.

**Phase 4. Audit session.** The one time Fede audits. Write and verify the twenty canonical queries and confirm real assertion bounds. Blocks phase 5.

**Phase 5. Sources page and alerting.** Freshness table, upload, cron, emails. FareHarbor automation investigation happens here.

**Phase 6. Statbank.** Mirror, search, pull, cache, attribution, the section 4.4 comparison behaviour.

**Phase 7. Dictionary and Gaps pages.** CRUD, hover tooltips, gap ranking.

---

## 12. Open questions blocking the build

Resolve with Fede before or during phase 0.

1. **Which FareHarbor reports does he download, and what columns do they contain?** Blocks the ingestion mapping in 4.2. Some may be redundant against bc-fleet.
2. **Can the FareHarbor report export be reached from the existing scraper session?** Determines whether 4.2 is automated or manual.
3. **Exact filesystem path of the fleet SQLite database.**
4. **Real bounds for the assertions in 3.5.** Fleet size by date, capacity per tour code, plausible monthly pax range.
5. **Which date is canonical**, booking date or departure date, for questions phrased as "in July". First definitions entry.
6. **PII policy**: block `is_pii` columns from query output entirely, or allow with the aggregate-by-default rule only?
7. **Confirm repo, subdomain and pm2 names** in section 1.
8. **The existing "brain" on the VPS**: what it is and why it disappointed. Not blocking, but the most useful single input for avoiding a repeat.
