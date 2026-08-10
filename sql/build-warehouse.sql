-- Builds the bc.* layer of the warehouse from the hourly fleet snapshot plus
-- the permanent log archive. Run by scripts/build-warehouse.sh, which builds
-- into a temp file and swaps it in atomically.
--
-- Everything here is MATERIALISED as tables, not left as views over the
-- attached SQLite file. Views would mean every query needs the snapshot
-- attached, and DuckDB allows only one writer per file, so the hourly rebuild
-- and a live read-only query would fight. Materialise, then swap: the agent
-- queries a self-contained file that nothing is writing to.
--
-- The agent must only ever see bc.*, never fleet_raw.

INSTALL sqlite; LOAD sqlite;
INSTALL json;   LOAD json;

ATTACH '/var/lib/bc-data/snapshots/fleet.db' AS fleet_raw (TYPE SQLITE, READ_ONLY);

CREATE SCHEMA IF NOT EXISTS bc;

-- ── Products ────────────────────────────────────────────────────────────────
-- A hand-maintained dimension, because the mapping from FareHarbor item ID to
-- our tour code lives in bc-fleet's source (TOUR_ITEMS in the v2 scraper and
-- TOUR_FEEDS in ical.js), not in any database.
--
-- stated_capacity is Fede's answer of 2026-08-10 and is a FALLBACK ONLY. Real
-- capacity comes per departure from FareHarbor (see bc.departures). It is here
-- so a departure FareHarbor never told us about still gets a sane denominator,
-- clearly labelled as an assumption rather than a measurement.
CREATE OR REPLACE TABLE bc.products AS
SELECT * FROM (VALUES
  ('A3',     'Architecture Tour (3h)',          'group_tour',   FALSE, 12),
  ('L3',     'Liveable City Tour (3h)',         'group_tour',   FALSE, 12),
  ('F3',     'Food Tour (3h)',                  'group_tour',   FALSE, 10),
  ('H3',     'History Tour (3h)',               'group_tour',   FALSE, 12),
  ('A3G',    'Architecture Tour German (3h)',   'group_tour',   FALSE, 12),
  ('A3F',    'Architecture Tour French (3h)',   'group_tour',   FALSE, 12),
  ('A3P',    'Private Architecture (3h)',       'private_tour', TRUE,  16),
  ('L3P',    'Private Liveable City (3h)',      'private_tour', TRUE,  16),
  ('F3P',    'Private Food Tour (3h)',          'private_tour', TRUE,  16),
  ('H3P',    'Private History (3h)',            'private_tour', TRUE,  16),
  ('L2P',    'Private Liveable City (2h)',      'private_tour', TRUE,  16),
  ('CUSTOM', 'Custom Tour',                     'custom_tour',  TRUE,  NULL)
) AS t(product_code, product_name, product_kind, is_private, stated_capacity);

-- ── Capacity, harvested from FareHarbor ─────────────────────────────────────
-- FareHarbor publishes capacity on every availability and bc-fleet's scraper
-- already downloads it, then discards it. It survives only inside the raw
-- payloads the scraper writes to tour_change_log.raw_data, so that is where we
-- mine it from. Read from the ARCHIVE, not the snapshot: tour_change_log is on
-- a 120 day retention in the live app and this is the only permanent copy.
--
-- Two traps, both confirmed against real data on 2026-08-10:
--
--  1. raw_data is capped at 4000 characters by the scraper, so many payloads
--     are truncated mid-JSON and will not parse. Regex-scan, never json parse.
--
--  2. "capacity": null is COMMON and it does not mean zero. On L2P, L3P, F3P
--     and H3P it is null on every single departure, meaning no seat limit is
--     configured in FareHarbor at all. Do NOT substitute bookable_capacity for
--     it: bookable_capacity is derived from free BIKES, not seats, and reaches
--     74 on L2P. Using it as a fill-rate denominator would be badly wrong.
CREATE OR REPLACE TABLE bc.departure_capacity AS
WITH payloads AS (
  SELECT
    availability_id,
    TRY_CAST(regexp_extract(raw_data, '"capacity":\s*(\d+)', 1) AS INTEGER) AS cap_seats,
    TRY_CAST(regexp_extract(raw_data, '"bookable_capacity":\s*(\d+)', 1) AS INTEGER) AS cap_bookable,
    created_at
  FROM read_parquet('/var/lib/bc-data/archive/tour_change_log/*.parquet')
  WHERE raw_data LIKE '%capacity%'
)
SELECT
  availability_id,
  -- max() ignores nulls, so a departure that ever reported a real number keeps
  -- it. No departure has been observed changing capacity, but if one ever does
  -- (Fede raising a private tour's limit for a group that emailed), the higher
  -- figure is the one that was actually sold against.
  MAX(cap_seats)    AS fh_capacity_seats,
  MAX(cap_bookable) AS fh_bookable_capacity_bikes,
  COUNT(*)          AS payloads_seen,
  MAX(created_at)   AS last_payload_at
FROM payloads
GROUP BY 1;

-- ── Departures ──────────────────────────────────────────────────────────────
-- Every tour departure that was OFFERED, whether it sold or not. This is the
-- only place empty departures exist anywhere, which is what makes fill rate
-- answerable at all. A bookings export can never show you a departure that
-- sold nothing.
CREATE OR REPLACE TABLE bc.departures AS
SELECT
  a.availability_id,
  a.feed_id                                   AS product_code,
  COALESCE(p.product_name, a.feed_label)      AS product_name,
  COALESCE(p.product_kind, 'unknown')         AS product_kind,
  COALESCE(p.is_private, a.feed_id LIKE '%P') AS is_private,
  CAST(a.start_date AS DATE)                  AS departure_date,
  -- The two writers disagree on time format and BOTH values live in this one
  -- column: the v2 scraper formats via Danish locale and writes '10.00', iCal
  -- writes '10:00'. As of 2026-08-10 that is 1061 dot rows against 81 colon
  -- rows, so `WHERE start_time = '10:00'` silently returns 7% of the
  -- departures it should. Normalised here to HH:MM, raw kept for tracing back.
  replace(a.start_time, '.', ':')             AS start_time,
  replace(a.end_time, '.', ':')               AS end_time,
  a.start_time                                AS start_time_raw,
  a.guide,
  -- On a TOUR row booking_count is PEOPLE (FareHarbor customer_count), not
  -- reservations. On a rental row the same column means reservations. They are
  -- split into two tables here so that trap cannot be walked into.
  a.booking_count                             AS pax,
  a.total_bikes,
  a.bikes_needed                              AS bikes_json,

  c.fh_capacity_seats                         AS capacity,
  CASE
    WHEN c.fh_capacity_seats IS NOT NULL          THEN 'fareharbor'
    WHEN p.product_kind = 'custom_tour'           THEN 'unlimited'
    WHEN p.stated_capacity IS NOT NULL            THEN 'stated_default'
    ELSE 'unknown'
  END                                         AS capacity_source,
  COALESCE(c.fh_capacity_seats, p.stated_capacity) AS capacity_effective,

  -- A private slot with nobody on it is open capacity, not a tour that ran
  -- empty. Counting those as empty departures is how bc-brain reported
  -- "Private Liveable City is 58 of 58 departures empty" and called it a
  -- finding. Anything measuring demand must filter on this.
  NOT (COALESCE(p.is_private, a.feed_id LIKE '%P') AND COALESCE(a.booking_count,0) = 0)
                                              AS is_real_departure,

  -- THE BIG ONE. Departure rows dated before 2026-08-03 all read pax = 0, and
  -- it is not true: the bookings ledger holds 180 tour bookings for July, and
  -- 179 of those 180 point at an availability_id that no longer exists in
  -- tour_availabilities at all. The departure rows for the tours that actually
  -- SOLD were deleted from the live database; what survives for July is mostly
  -- the private slots that never sold. Verified 2026-08-10.
  --
  -- Left unfixed, "how did July go" answers "93 departures, 0 passengers, 0%
  -- full" with total confidence. That is the single worst answer this tool
  -- could give, so pax and fill_rate are gated on this flag and the catalog
  -- carries a blocking assertion on it.
  (CAST(a.start_date AS DATE) >= DATE '2026-08-03')  AS pax_is_reliable,

  -- NULL rather than a guess wherever the denominator is not trustworthy:
  -- CUSTOM has no limit, an unsold private slot is not a departure, and
  -- anything before 2026-08-03 has a numerator that is not real.
  CASE
    WHEN CAST(a.start_date AS DATE) < DATE '2026-08-03' THEN NULL
    WHEN p.product_kind = 'custom_tour' THEN NULL
    WHEN COALESCE(p.is_private, a.feed_id LIKE '%P') AND COALESCE(a.booking_count,0) = 0 THEN NULL
    WHEN COALESCE(c.fh_capacity_seats, p.stated_capacity) > 0
      THEN ROUND(a.booking_count * 1.0 / COALESCE(c.fh_capacity_seats, p.stated_capacity), 4)
    ELSE NULL
  END                                         AS fill_rate,

  CAST(a.last_synced AS TIMESTAMP)            AS last_synced_at
FROM fleet_raw.tour_availabilities a
LEFT JOIN bc.products p            ON p.product_code = a.feed_id
LEFT JOIN bc.departure_capacity c  ON c.availability_id = a.availability_id
WHERE a.feed_type = 'tour';

-- ── Recovered departures (BEST EFFORT, DO NOT MIX WITH bc.departures) ───────
-- Reconstructs departures that no longer exist in the live database, from the
-- archived change log. This is the ONLY surviving trace of July's departures.
--
-- It is deliberately a SEPARATE table and is deliberately NOT unioned into
-- bc.departures, because it demonstrably over-counts. Measured against August,
-- where the live rows are trustworthy ground truth:
--
--     live (truth)   288 departures   294 pax
--     this table     455 departures   421 pax     (+43% pax)
--
-- The cause is FareHarbor reissuing an availability's internal ID whenever a
-- private tour is edited, so the same real departure appears under several IDs.
-- Deduping needs start_time, which the change log does not record, so it cannot
-- be done reliably. Merging this into bc.departures would trade a visible hole
-- for an invisible inflation, which is a much worse trade.
--
-- Use it to say "July existed and sold roughly this much", never to report a
-- precise July figure. The agent must state the +43% caveat whenever it touches
-- this table.
CREATE OR REPLACE TABLE bc.departures_recovered AS
WITH ev AS (
  SELECT availability_id, feed_id,
         TRY_CAST(start_date AS DATE)  AS departure_date,
         field, old_value, new_value,
         CAST(created_at AS TIMESTAMP) AS ts
  FROM read_parquet('/var/lib/bc-data/archive/tour_change_log/*.parquet')
  WHERE start_date IS NOT NULL
),
final_pax AS (
  SELECT availability_id, TRY_CAST(new_value AS INTEGER) AS pax
  FROM ev WHERE field = 'booking_count'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY availability_id ORDER BY ts DESC) = 1
),
final_guide AS (
  SELECT availability_id, new_value AS guide
  FROM ev WHERE field = 'guide' AND COALESCE(new_value, '') <> ''
  QUALIFY ROW_NUMBER() OVER (PARTITION BY availability_id ORDER BY ts DESC) = 1
),
-- The sweep has logged false cancellations before (the fleet's own notes record
-- nine phantom A3P cancel emails in one sync), so this is surfaced as a flag to
-- weigh, never used to silently drop a departure.
marked_cancelled AS (
  SELECT DISTINCT availability_id FROM ev
  WHERE field = 'status' AND new_value = 'cancelled'
),
meta AS (
  SELECT availability_id, MAX(feed_id) AS feed_id, MAX(departure_date) AS departure_date,
         MIN(ts) AS first_seen_at, MAX(ts) AS last_seen_at
  FROM ev GROUP BY 1
)
SELECT
  m.availability_id,
  m.feed_id                       AS product_code,
  p2.product_name,
  p2.product_kind,
  COALESCE(p2.is_private, m.feed_id LIKE '%P') AS is_private,
  m.departure_date,
  fp.pax                          AS pax_last_logged,
  fg.guide                        AS guide_last_logged,
  (mc.availability_id IS NOT NULL) AS was_marked_cancelled,
  (l.availability_id IS NOT NULL)  AS still_in_live_db,
  m.first_seen_at,
  m.last_seen_at
FROM meta m
LEFT JOIN final_pax fp        ON fp.availability_id = m.availability_id
LEFT JOIN final_guide fg      ON fg.availability_id = m.availability_id
LEFT JOIN marked_cancelled mc ON mc.availability_id = m.availability_id
LEFT JOIN bc.departures l     ON l.availability_id  = m.availability_id
LEFT JOIN bc.products p2      ON p2.product_code    = m.feed_id;

-- ── Rentals ─────────────────────────────────────────────────────────────────
-- Split from departures because booking_count changes meaning here: it is
-- RESERVATIONS, not people. Note this table is a short rolling cache in the
-- fleet app (roughly a week back); bc.bookings is the durable rental record.
CREATE OR REPLACE TABLE bc.rental_slots AS
SELECT
  availability_id,
  feed_id                                          AS rental_code,
  TRY_CAST(REPLACE(feed_id, '-D', '') AS INTEGER)  AS rental_days,
  CAST(start_date AS DATE)                         AS pickup_date,
  replace(start_time, '.', ':')                    AS start_time,   -- see bc.departures
  booking_count                                    AS reservations,
  total_bikes,
  bikes_needed                                     AS bikes_json,
  CAST(last_synced AS TIMESTAMP)                   AS last_synced_at
FROM fleet_raw.tour_availabilities
WHERE feed_type = 'rental';

-- ── Bookings ────────────────────────────────────────────────────────────────
-- The permanent booking ledger. bc-fleet never deletes from it.
--
-- Three things this view makes explicit rather than leaving as landmines:
--   total is TEXT like 'DKK1,200.00' and is parsed to a number here;
--   booking_created_at is NULL on 40% of rows (rental and Airbnb bookings do
--     not fire the FareHarbor webhook), so the fallback is named and flagged;
--   there is NO cancellation flag anywhere, so every figure is gross of
--     cancellations and gross of OTA commission.
CREATE OR REPLACE TABLE bc.bookings AS
SELECT
  ref                                     AS booking_ref,
  availability_id,
  feed_id                                 AS product_code,
  feed_type                               AS product_type,
  CAST(tour_start_date AS DATE)           AS departure_date,
  CAST(booking_created_at AS DATE)        AS booked_date,
  CAST(COALESCE(booking_created_at, first_seen_at) AS DATE) AS booked_date_effective,
  (booking_created_at IS NULL)            AS booked_date_is_approx,
  COALESCE(NULLIF(source, ''), 'direct')  AS channel,
  TRY_CAST(REPLACE(REPLACE(total, 'DKK', ''), ',', '') AS DOUBLE) AS gross_dkk,
  total                                   AS gross_raw,
  customer_name,                          -- is_pii
  customer_email,                         -- is_pii
  customer_phone,                         -- is_pii
  CAST(first_seen_at AS TIMESTAMP)        AS first_seen_at,
  CAST(last_seen_at  AS TIMESTAMP)        AS last_seen_at
FROM fleet_raw.bookings;

-- ── Bikes per departure ─────────────────────────────────────────────────────
-- bikes_needed is a JSON object like {"A":3,"GT":4}. Unnested here so that
-- "how many cargo bikes went out in July" is a GROUP BY rather than a puzzle.
CREATE OR REPLACE TABLE bc.departure_bikes AS
SELECT
  d.availability_id, d.product_code, d.departure_date, d.is_private,
  j.key                        AS bike_type_id,
  TRY_CAST(j.value AS INTEGER) AS bikes
FROM bc.departures d,
     LATERAL json_each(CASE WHEN d.bikes_json IS NULL OR d.bikes_json = '' THEN '{}' ELSE d.bikes_json END) AS j
WHERE TRY_CAST(j.value AS INTEGER) > 0;

-- ── Guide hours ─────────────────────────────────────────────────────────────
-- duration_minutes is BUFFERED wall time, not tour length: F3/F3P carry a
-- 30+30 minute buffer, everything else 15+15. Named so nobody reports it as
-- how long a tour is.
CREATE OR REPLACE TABLE bc.guide_hours AS
SELECT
  h.availability_id,
  h.guide                       AS guide_name,
  h.feed_id                     AS product_code,
  CAST(h.start_date AS DATE)    AS departure_date,
  h.duration_minutes            AS buffered_minutes,
  ROUND(h.duration_minutes / 60.0, 2) AS buffered_hours,
  h.booking_count               AS pax
FROM fleet_raw.guide_tour_hours h;

-- ── Reviews ─────────────────────────────────────────────────────────────────
-- NOT a satisfaction measure. A 50 DKK bonus is paid per five-star review, so
-- the sample is biased twice over: which customers are asked, and which
-- reviews get logged. Review COUNTS are a measure of guide effort, at best.
CREATE OR REPLACE TABLE bc.guide_reviews AS
SELECT
  r.id                          AS review_id,
  r.guide_id,
  t.name                        AS guide_name,
  CAST(r.review_date AS DATE)   AS review_date,
  r.platform                    AS channel,
  r.booking_type,
  r.reviewer_name
FROM fleet_raw.guide_reviews r
LEFT JOIN fleet_raw.team_members t ON t.id = r.guide_id;

-- ── Fleet ───────────────────────────────────────────────────────────────────
-- Point in time ONLY. bikes.created_at is when the row was seeded during the
-- 2026-06-28 setup, not when the bike was bought, and retirement has no date.
-- So "how many bikes did we have last March" is not answerable and any
-- assertion phrased as "fleet size on that date" is not computable.
CREATE OR REPLACE TABLE bc.fleet_bikes AS
SELECT
  b.id                 AS bike_id,
  b.type_id            AS bike_type_id,
  bt.label             AS bike_type,
  bt.rental_value_dkk,
  bt.fareharbor_resource,
  b.active,
  s.status,
  s.out_since,
  s.return_due,
  cfg.has_child_seat,
  cfg.has_toddler_seat
FROM fleet_raw.bikes b
JOIN fleet_raw.bike_types bt          ON bt.id = b.type_id
LEFT JOIN fleet_raw.bike_status s     ON s.bike_id = b.id
LEFT JOIN fleet_raw.bike_configurations cfg ON cfg.bike_id = b.id;

CREATE OR REPLACE TABLE bc.repairs AS
SELECT
  t.id                          AS ticket_id,
  t.bike_id,
  b.type_id                     AS bike_type_id,
  t.problem,
  t.problem_categories,
  t.status,
  t.can_rent,
  CAST(t.created_at AS DATE)    AS opened_date,
  CAST(t.resolved_at AS DATE)   AS resolved_date,
  -- resolved_at is TEXT and now() is a timestamptz, so the COALESCE has to
  -- happen after both sides are DATEs, not before.
  date_diff('day', CAST(t.created_at AS DATE),
            COALESCE(CAST(t.resolved_at AS DATE), current_date)) AS days_open
FROM fleet_raw.repair_tickets t
LEFT JOIN fleet_raw.bikes b ON b.id = t.bike_id;

CREATE OR REPLACE TABLE bc.team AS
SELECT id AS member_id, name, role, active, is_guide, can_shop
FROM fleet_raw.team_members;

-- ── Booking pace ────────────────────────────────────────────────────────────
-- Reconstructed from the archived change log: every time a departure's pax
-- moved, and when. This is the ONLY way to answer "how far ahead do people
-- book" or "is this departure filling faster than usual", and it is the single
-- thing worth rescuing from the log tables before the fleet app's 120 day
-- retention deletes them.
--
-- Only real movements survive here. The fleet app has a known bug that relogs
-- an unchanged value every 90 seconds, so identical consecutive rows are
-- collapsed. 283,928 log rows reduce to a few thousand actual changes.
CREATE OR REPLACE TABLE bc.booking_pace AS
WITH raw AS (
  SELECT
    availability_id, feed_id AS product_code,
    TRY_CAST(start_date AS DATE)       AS departure_date,
    TRY_CAST(new_value AS INTEGER)     AS pax,
    TRY_CAST(old_value AS INTEGER)     AS pax_before,
    CAST(created_at AS TIMESTAMP)      AS changed_at,
    source
  FROM read_parquet('/var/lib/bc-data/archive/tour_change_log/*.parquet')
  WHERE field = 'booking_count'
),
deduped AS (
  SELECT *,
         LAG(pax) OVER (PARTITION BY availability_id ORDER BY changed_at) AS prev_pax
  FROM raw
  WHERE pax IS NOT NULL
)
SELECT
  availability_id, product_code, departure_date, changed_at, source,
  pax_before, pax,
  pax - COALESCE(prev_pax, pax_before, 0) AS pax_delta,
  date_diff('day', CAST(changed_at AS DATE), departure_date) AS days_before_departure
FROM deduped
WHERE prev_pax IS NULL OR pax <> prev_pax;

-- ── Freshness ───────────────────────────────────────────────────────────────
-- Every answer has to state "data as of". This is where that comes from.
CREATE OR REPLACE TABLE bc.data_freshness AS
SELECT 'fleet_snapshot' AS source_key,
       CAST((SELECT content FROM read_text('/var/lib/bc-data/snapshots/_loaded_at')) AS TIMESTAMP) AS loaded_at,
       (SELECT COUNT(*) FROM bc.departures)  AS departures,
       (SELECT COUNT(*) FROM bc.bookings)    AS bookings,
       (SELECT MIN(departure_date) FROM bc.departures) AS earliest_departure,
       (SELECT MAX(departure_date) FROM bc.departures) AS latest_departure,
       (SELECT MAX(changed_at) FROM bc.booking_pace)   AS latest_change_logged;

DETACH fleet_raw;
