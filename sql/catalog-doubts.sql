-- The Doubts queue.
--
-- Fede, 2026-08-10: "there should probably be a section of the app where all
-- the doubts of the models are listed, like atomic nuggets of doubts, which I
-- can confirm or deny, check mark or big X".
--
-- WHY THIS IS THE RIGHT SHAPE. Uncertainty was already being recorded all over
-- the catalog: 130 column descriptions with reviewed_by NULL, 20 canonical
-- queries with verified_by NULL, 7 invoice figures read by a model and checked
-- by nobody, assertion bounds measured off six weeks of data, gap effort
-- estimates the amendment itself says Fede should review. All of it honest, and
-- all of it invisible unless you went looking table by table.
--
-- This table is one queue over all of it. One doubt, one sentence, tick or
-- cross.
--
-- It also quietly replaces the shape of phase 4. The spec had a single audit
-- session where Fede verifies twenty queries in one sitting; a queue does the
-- same work continuously, in the order that matters, and keeps working
-- afterwards as new uncertainty arrives.
--
-- THE CRITICAL PART IS writeback_sql. A doubt that is confirmed and then does
-- nothing is a to-do list, not a review system: the description stays
-- unreviewed, the query stays unverified, and the same doubt comes back
-- tomorrow. Confirming must actually mark the thing reviewed, which is what
-- that column is for.

CREATE TABLE IF NOT EXISTS catalog.doubts (
  doubt_id     VARCHAR PRIMARY KEY,
  created_at   TIMESTAMP,
  kind         VARCHAR,   -- column_description | canonical_query | invoice_figure
                          -- | assertion_bound | gap_estimate | upload_caveat
                          -- | correction | business_fact
  subject      VARCHAR,   -- what it is about, e.g. 'bc.bookings.gross_dkk'
  question     TEXT,      -- ONE sentence, plain English, answerable yes or no
  detail       TEXT,      -- the context needed to answer it
  proposed     TEXT,      -- what the model currently believes
  impact       TEXT,      -- what goes wrong if this is wrong
  priority     INTEGER DEFAULT 5,  -- 1 highest. Ranks the queue.
  writeback_sql TEXT,     -- run on confirm, so confirming actually does something
  status       VARCHAR DEFAULT 'open',  -- open | confirmed | denied | skipped
  decided_by   VARCHAR,
  decided_at   TIMESTAMP,
  note         TEXT       -- what Fede said, especially on a denial
);

-- A denial is the valuable half. It is a correction in the making: something
-- the model believed, a person said no, and the reason is knowledge that exists
-- nowhere else. Denials feed catalog.corrections, which feeds the prompt.
CREATE INDEX IF NOT EXISTS idx_doubts_status ON catalog.doubts(status, priority);
