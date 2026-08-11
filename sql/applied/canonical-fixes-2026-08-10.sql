-- Two canonical queries rewritten, from Fede's answers in the Doubts queue.
--
-- 1. bike_type_demand. He denied it and asked: "we don't own 255 guided bikes,
--    so what does bikes allocated mean exactly?"
--
--    He was right and the column name was wrong, not merely unclear.
--    bikes_allocated summed bikes across departures, so 255 was the number of
--    TIMES a guided bike went out across 76 departures. He owns 9. A column
--    that reads as a fleet count and is 28 times the fleet is not a labelling
--    nitpick, it is a wrong answer waiting to be quoted in a meeting.
--
--    Now: departures, times_taken_out, avg_per_departure, and we_own beside it
--    so the two numbers can never be mistaken for each other again.
--
-- 2. bikes_out_on_date. "No, I'd expect a straightforward answer, and ideally a
--    breakdown of bike type."
--
--    The old one gave a bare total for tours only, silently excluding rentals,
--    which for a "do we have enough bikes" question is the half that bites.
--    Now: the total first, then tours vs rentals, then the per-type breakdown.
--    Rentals are labelled as having no bike type recorded rather than being
--    quietly left out of the breakdown.

UPDATE catalog.canonical_queries SET
  sql = 'WITH owned AS (SELECT bike_type_id, COUNT(*) AS we_own FROM bc.fleet_bikes WHERE active = 1 GROUP BY 1),
     names AS (SELECT DISTINCT bike_type_id, bike_type FROM bc.fleet_bikes)
SELECT n.bike_type                       AS bike_type,
       COUNT(DISTINCT b.availability_id) AS departures,
       SUM(b.bikes)                      AS times_taken_out,
       ROUND(SUM(b.bikes) * 1.0 / COUNT(DISTINCT b.availability_id), 1) AS avg_per_departure,
       COALESCE(o.we_own, 0)             AS we_own
FROM bc.departure_bikes b
LEFT JOIN names n USING (bike_type_id)
LEFT JOIN owned o USING (bike_type_id)
GROUP BY 1, 5 ORDER BY times_taken_out DESC',
  notes = 'times_taken_out counts BIKE OUTINGS, not bikes. 255 guided bikes taken out across 76 departures is 9 bikes going out again and again, not 255 bikes. we_own sits next to it so the two can never be confused. This is also what was ALLOCATED to a departure, not what a customer actually collected: there is no no-show data anywhere.',
  verified_by = NULL, verified_at = NULL
WHERE query_key = 'bike_type_demand';

UPDATE catalog.canonical_queries SET
  sql = 'WITH names AS (SELECT DISTINCT bike_type_id, bike_type FROM bc.fleet_bikes)
SELECT 1 AS sort, ''TOTAL BIKES OUT'' AS what, bikes_out AS bikes, fleet_size_today AS fleet_size
  FROM bc.daily_bike_load WHERE load_date = ${date}
UNION ALL SELECT 2, ''  on tours'', tour_bikes, NULL FROM bc.daily_bike_load WHERE load_date = ${date}
UNION ALL SELECT 3, ''  on rentals (bike type not recorded)'', rental_bikes, NULL FROM bc.daily_bike_load WHERE load_date = ${date}
UNION ALL
SELECT 4, ''  tours: '' || COALESCE(n.bike_type, b.bike_type_id), SUM(b.bikes), NULL
  FROM bc.departure_bikes b LEFT JOIN names n USING (bike_type_id)
  WHERE b.departure_date = ${date} GROUP BY 2
ORDER BY sort, bikes DESC',
  notes = 'Total first, then the split, then the per-type breakdown. Rentals ARE included in the total (the old version was tours only, which understated the busiest days), but rentals carry no bike type, so they appear as one line rather than being dropped from the breakdown. Compare bikes against fleet_size before saying yes, there are enough.',
  verified_by = NULL, verified_at = NULL
WHERE query_key = 'bikes_out_on_date';

-- The word itself, so it is glossed wherever it appears rather than only inside
-- this one query. Fede reads the answers, not the SQL.
INSERT OR REPLACE INTO catalog.definitions (term, definition, sql_snippet, do_not_use, updated_at, updated_by)
VALUES ('taken out',
        'The number of times a bike went out, counted once per departure it was assigned to. A bike that goes out every day for a week has been taken out 7 times. It is a measure of USE, never of how many bikes exist.',
        'SUM(bikes) FROM bc.departure_bikes',
        'Never present it as a fleet count or a bike count. BeCopenhagen owns 9 guided bikes and they were taken out 255 times; saying "255 guided bikes" is wrong by a factor of 28. Say "taken out 255 times" and put the fleet number beside it.',
        now(), 'fede (2026-08-10, via the Doubts queue)');
