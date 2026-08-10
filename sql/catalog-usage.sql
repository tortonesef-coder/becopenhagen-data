-- How each source is ACTUALLY used, and the curator's proposals.
--
-- Fede, 2026-08-10: "every time it's used it also logs how it was used. Altho,
-- there should be a way to make it so that it logs it only when it was
-- appropriately used, usefully used."
--
-- That caveat is the whole design problem. bc.departures appears in almost every
-- query, so a raw count of appearances says nothing: it would rank the tables
-- that are merely convenient above the ones that actually answered something.
--
-- So usage is logged at three levels, and the level is what makes the number
-- mean anything:
--
--   referenced   the table appears in the SQL. Objective, parsed from the query.
--   load_bearing the answer's headline number came out of it. Self-reported by
--                the agent, which knows which figure it led with.
--   decisive     it changed the conclusion. Something in this source is why the
--                answer says what it says rather than the opposite.
--
-- A source referenced fifty times and never load-bearing is a source that keeps
-- getting joined and never earns its place. That is a finding, and only the
-- three-level split can surface it.
--
-- And a correction DOWNGRADES the usage it was attached to: if Fede says the
-- answer was wrong, the sources that carried it did not in fact serve.

CREATE TABLE IF NOT EXISTS catalog.source_usage (
  usage_id     BIGINT PRIMARY KEY,
  used_at      TIMESTAMP,
  source_key   VARCHAR,     -- bc.<table>
  query_log_id BIGINT,      -- which question
  username     VARCHAR,
  level        VARCHAR,     -- referenced | load_bearing | decisive
  note         TEXT,        -- why it mattered, when the agent says so
  corrected    BOOLEAN DEFAULT FALSE  -- the answer was later corrected
);
CREATE SEQUENCE IF NOT EXISTS catalog.source_usage_id START 1;

-- The curator's output. Proposals, never actions.
--
-- Fede: "a curator that looks for opportunities for relevant mergers (additive
-- only, never replacing), or new databases."
--
-- ADDITIVE ONLY is enforced by shape, not by good intentions: a proposal can
-- only ever suggest a NEW view or a NEW source. There is no proposal type that
-- drops, replaces or rewrites an existing one, so the worst a bad proposal can
-- do is add something nobody uses.
CREATE TABLE IF NOT EXISTS catalog.curator_proposals (
  proposal_id  VARCHAR PRIMARY KEY,
  created_at   TIMESTAMP,
  kind         VARCHAR,   -- merge_view | fills_gap | unused_source | missing_link | new_source
  title        VARCHAR,   -- one line, plain English
  rationale    TEXT,      -- why the curator thinks so
  evidence     TEXT,      -- the counts and names it based that on
  proposed_sql TEXT,      -- the CREATE VIEW it would add. Always additive.
  affects      TEXT,      -- which sources or gaps
  confidence   VARCHAR,   -- high | medium | low
  status       VARCHAR DEFAULT 'open',  -- open | accepted | rejected | built
  decided_by   VARCHAR,
  decided_at   TIMESTAMP,
  note         TEXT
);
