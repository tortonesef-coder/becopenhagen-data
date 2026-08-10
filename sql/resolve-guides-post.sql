-- Attaches the resolved guide identity to every table carrying a guide name.
--
-- Runs AFTER scripts/resolve-guides.js has built bc.guide_identity, which is
-- why this is a separate file from build-warehouse.sql: the mapping is computed
-- in Node (accent stripping, aliases, Levenshtein) rather than in SQL.
--
-- After this, guide questions join on guide_id and nobody's hours go missing
-- because FareHarbor spelled their name differently from the fleet app.

ALTER TABLE bc.departures ADD COLUMN IF NOT EXISTS guide_id VARCHAR;
ALTER TABLE bc.departures ADD COLUMN IF NOT EXISTS guide_canonical VARCHAR;
UPDATE bc.departures d SET
  guide_id        = i.member_id,
  guide_canonical = i.guide_name
FROM bc.guide_identity i WHERE i.guide_raw = d.guide;

ALTER TABLE bc.guide_hours ADD COLUMN IF NOT EXISTS guide_id VARCHAR;
ALTER TABLE bc.guide_hours ADD COLUMN IF NOT EXISTS guide_canonical VARCHAR;
UPDATE bc.guide_hours h SET
  guide_id        = i.member_id,
  guide_canonical = i.guide_name
FROM bc.guide_identity i WHERE i.guide_raw = h.guide_name;

ALTER TABLE bc.departures_recovered ADD COLUMN IF NOT EXISTS guide_id VARCHAR;
ALTER TABLE bc.departures_recovered ADD COLUMN IF NOT EXISTS guide_canonical VARCHAR;
UPDATE bc.departures_recovered r SET
  guide_id        = i.member_id,
  guide_canonical = i.guide_name
FROM bc.guide_identity i WHERE i.guide_raw = r.guide_last_logged;

-- bc.guide_reviews already carries the fleet's own guide_id, so it needs no
-- resolution. Adding guide_canonical anyway means every guide table can be
-- grouped by the same column name without the agent having to remember which
-- table is which.
ALTER TABLE bc.guide_reviews ADD COLUMN IF NOT EXISTS guide_canonical VARCHAR;
UPDATE bc.guide_reviews r SET guide_canonical = t.name
FROM bc.team t WHERE t.member_id = r.guide_id;
