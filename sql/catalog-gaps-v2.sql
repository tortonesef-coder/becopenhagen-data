-- catalog.gaps, version 2. Replaces the six-column table from phase 2.
--
-- Per amendment_01_sources.md section 1. The seven new columns exist so the
-- agent can tell whether a source could actually be CONNECTED to anything
-- before it suggests it:
--
--   join_key is the important one. A source marked 'none: comparison only' may
--   be used for context and contradiction but never for arithmetic against
--   bc.*, per section 4.4 of the spec. Monthly regional statistics cannot be
--   joined to a booking; daily weather can.
--
--   grain stops the agent offering monthly data to a question about one
--   departure, which is worse than saying nothing.
--
--   status turns this from a wishlist into a lifecycle table. Every source in
--   the warehouse started here as a gap.
--
-- MIGRATION, NOT REPLACEMENT. cited_count is earned at runtime and ranks the
-- roadmap, so it is carried across rather than reset. As of this migration
-- history_pre_2026 has been cited 9 times, which is real signal about what Fede
-- and Søren actually keep running into.

CREATE TABLE IF NOT EXISTS catalog.gaps_v2 (
  gap_key      VARCHAR PRIMARY KEY,
  category     VARCHAR,   -- internal | official | open | competitive | derived
  missing      TEXT,      -- what we don't have
  contains     TEXT,      -- what is actually in it
  unlocks      TEXT,      -- questions it would answer
  how_to_get   TEXT,
  grain        TEXT,      -- 'daily', 'per booking', 'monthly by region'
  join_key     TEXT,      -- how it connects to bc.*, or 'none: comparison only'
  effort       VARCHAR,   -- low | medium | high
  cost         VARCHAR,   -- free | subscription | staff time
  licence      TEXT,
  status       VARCHAR,   -- gap | investigating | ingested | rejected | partial
  cited_count  INTEGER DEFAULT 0
);

-- Carry the existing rows and their earned citation counts across. The old
-- table's columns are a strict subset of the new one's, so nothing is lost;
-- the seed below then fills in the new columns for each.
INSERT INTO catalog.gaps_v2 (gap_key, missing, unlocks, how_to_get, effort, cited_count)
SELECT gap_key, missing, unlocks, how_to_get, effort, cited_count
FROM catalog.gaps
ON CONFLICT (gap_key) DO UPDATE SET cited_count = excluded.cited_count;

DROP TABLE catalog.gaps;
ALTER TABLE catalog.gaps_v2 RENAME TO gaps;
