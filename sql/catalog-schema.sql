-- The catalog. Section 3 of spec_data.md.
--
-- Lives in its OWN DuckDB file, /var/lib/bc-data/catalog.duckdb, deliberately
-- separate from warehouse.duckdb. The warehouse is rebuilt from scratch every
-- hour and swapped out; anything hand-written in it would be destroyed on the
-- next tick. The catalog holds exactly the things that must survive: what Fede
-- and Søren agreed a word means, what has already gone wrong, and every
-- question ever asked.
--
-- Idempotent. Safe to re-run on every deploy. Seed data is separate
-- (catalog-seed.sql) so re-running the schema never overwrites Fede's edits.

CREATE SCHEMA IF NOT EXISTS catalog;

-- ── What data exists, and what is wrong with it ─────────────────────────────
CREATE TABLE IF NOT EXISTS catalog.sources (
  source_key             VARCHAR PRIMARY KEY,
  display_name           VARCHAR,
  schema_name            VARCHAR,
  layer                  VARCHAR,   -- raw | view | external
  description            TEXT,
  grain                  TEXT,      -- what one row IS
  refresh_cadence_hours  INTEGER,
  retrieval_method       VARCHAR,   -- auto | manual
  retrieval_instructions TEXT,      -- exact steps to refresh by hand
  gotchas                TEXT,      -- the highest-value column in the system
  last_loaded_at         TIMESTAMP,
  last_row_count         BIGINT,
  prev_row_count         BIGINT,
  max_date_in_data       DATE,
  owner                  VARCHAR
);

CREATE TABLE IF NOT EXISTS catalog.columns (
  schema_name   VARCHAR,
  table_name    VARCHAR,
  column_name   VARCHAR,
  data_type     VARCHAR,
  description   TEXT,
  gotcha        TEXT,
  sample_values TEXT,
  is_pii        BOOLEAN DEFAULT FALSE,
  -- Not in the spec, but the spec says these must not ship unreviewed, and
  -- "unreviewed" has to be a fact the UI can see rather than a good intention.
  drafted_by    VARCHAR,
  reviewed_by   VARCHAR,
  reviewed_at   TIMESTAMP,
  PRIMARY KEY (schema_name, table_name, column_name)
);

-- ── The business dictionary ─────────────────────────────────────────────────
-- Injected into the system prompt on every call. Small and load bearing: it is
-- the only thing stopping Fede and Søren getting different numbers for the same
-- question, both off defensible SQL.
CREATE TABLE IF NOT EXISTS catalog.definitions (
  term        VARCHAR PRIMARY KEY,
  definition  TEXT,
  sql_snippet TEXT,
  do_not_use  TEXT,   -- the plausible-but-wrong alternative
  updated_at  TIMESTAMP,
  updated_by  VARCHAR
);

CREATE TABLE IF NOT EXISTS catalog.canonical_queries (
  query_key        VARCHAR PRIMARY KEY,
  question_pattern TEXT,
  sql              TEXT,
  notes            TEXT,
  verified_by      VARCHAR,
  verified_at      TIMESTAMP
);

-- ── The deterministic safety layer ──────────────────────────────────────────
-- Run on every load and every query result. Unlike the model reviewing its own
-- SQL, these actually hold.
CREATE TABLE IF NOT EXISTS catalog.assertions (
  assertion_key VARCHAR PRIMARY KEY,
  target        VARCHAR,   -- schema.table, or '*' for result level
  expression    TEXT,      -- SQL boolean, must evaluate TRUE
  message       TEXT,
  severity      VARCHAR,   -- block | warn
  bounds_source VARCHAR    -- measured | stated_by_fede | guessed
);

-- ── Scientist mode ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog.gaps (
  gap_key     VARCHAR PRIMARY KEY,
  missing     TEXT,
  unlocks     TEXT,
  how_to_get  TEXT,
  effort      VARCHAR,   -- low | medium | high
  cited_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS catalog.limits (
  limit_key  VARCHAR PRIMARY KEY,
  rule       TEXT,
  applies_to TEXT
);

-- ── Statbank mirror (phase 6) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog.statbank_tables (
  table_id      VARCHAR PRIMARY KEY,
  title_en      VARCHAR,
  title_da      VARCHAR,
  subject_path  VARCHAR,
  variables     JSON,
  first_period  VARCHAR,
  latest_period VARCHAR,
  dst_updated   TIMESTAMP
);

-- ── Every question ever asked ───────────────────────────────────────────────
-- How you find out later that a number was wrong. Not optional.
-- Contains PII inside stored SQL and result summaries (Fede's 2026-08-10
-- decision allows identified rows), so it has its own retention.
CREATE TABLE IF NOT EXISTS catalog.query_log (
  id                  BIGINT PRIMARY KEY,
  asked_at            TIMESTAMP,
  username            VARCHAR,
  question            TEXT,
  sql_run             TEXT,
  result_summary      TEXT,
  row_count           INTEGER,
  assertions_fired    TEXT,
  gap_cited           VARCHAR,
  canonical_query_key VARCHAR,
  latency_ms          INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cached_tokens       INTEGER,
  cost_usd            DOUBLE,
  model               VARCHAR,
  error               TEXT
);

CREATE SEQUENCE IF NOT EXISTS catalog.query_log_id START 1;

CREATE TABLE IF NOT EXISTS catalog.settings (
  key        VARCHAR PRIMARY KEY,
  value      VARCHAR,
  updated_at TIMESTAMP,
  updated_by VARCHAR
);

-- ── What Fede and Søren say back ────────────────────────────────────────────
-- Fede, 2026-08-10: "the info I provide in the chat, in response to a response,
-- should be kept as valuable info, maybe it's an important correction about
-- assumptions."
--
-- He is right, and it is the highest-value table in here after gotchas. When
-- someone reads an answer and replies "no, private tours can go above 16 if
-- they email us", that sentence is worth more than the answer was. It is
-- knowledge that exists nowhere in FareHarbor, nowhere in the fleet database,
-- and nowhere in this catalog until somebody writes it down.
--
-- Kept FOREVER, like the query log. A correction has no expiry: a wrong
-- assumption corrected in 2026 is still corrected in 2029.
--
-- The loop this closes: correction captured -> applied into gotchas, definitions
-- or limits -> the agent stops making that mistake. status tracks where in that
-- loop each one is, so nothing sits captured-but-ignored.
CREATE TABLE IF NOT EXISTS catalog.corrections (
  id             BIGINT PRIMARY KEY,
  said_at        TIMESTAMP,
  said_by        VARCHAR,
  correction     TEXT,      -- what they actually said, verbatim where possible
  context        TEXT,      -- what was being discussed, so it stays interpretable
  query_log_id   BIGINT,    -- the answer being corrected, when there is one
  applies_to     VARCHAR,   -- 'bc.departures' | 'definition:fill rate' | 'limit:small_n' | free text
  status         VARCHAR DEFAULT 'new',   -- new | applied | rejected | superseded
  applied_where  TEXT,      -- which catalog row now carries this knowledge
  applied_at     TIMESTAMP
);

CREATE SEQUENCE IF NOT EXISTS catalog.corrections_id START 1;
