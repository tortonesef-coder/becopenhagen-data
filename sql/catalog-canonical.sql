-- Canonical queries: the recurring questions, answered once, correctly.
--
-- The agent MUST call find_canonical_query before writing fresh SQL, and must
-- use a strong match verbatim rather than composing its own. That is the whole
-- point: these have the gotchas already baked in, and freshly written SQL will
-- not have them.
--
-- Every query here is DRAFTED, not verified. verified_by is deliberately NULL.
-- Phase 4 is the one session where Fede goes through these with me and confirms
-- each number against what he knows to be true; only then does verified_by get
-- filled in. Drafting them now means phase 4 is a review session rather than a
-- writing session, which is a much better use of the hour he has.
--
-- Each one has been executed against the real warehouse and returns rows.

DELETE FROM catalog.canonical_queries WHERE verified_by IS NULL;

INSERT INTO catalog.canonical_queries (query_key, question_pattern, sql, notes) VALUES

('pax_by_month',
 'how many people / passengers / pax in {month}; how busy was {month}',
 'SELECT strftime(departure_date, ''%Y-%m'') AS ym, SUM(pax) AS pax, COUNT(*) FILTER (WHERE is_real_departure) AS departures_that_ran
  FROM bc.departures WHERE pax_is_reliable GROUP BY 1 ORDER BY 1',
 'Filters pax_is_reliable, so anything before 2026-08-03 is excluded rather than reported as zero. Say that the earlier months are missing, do not silently return a short list.'),

('fill_rate_by_product',
 'how full are our tours; fill rate / occupancy by product; which tour sells best',
 'SELECT product_code, COUNT(*) AS departures, SUM(pax) AS pax, MAX(capacity_effective) AS capacity, ROUND(AVG(fill_rate)*100, 1) AS avg_fill_pct
  FROM bc.departures
  WHERE fill_rate IS NOT NULL AND departure_date < current_date
  GROUP BY 1 HAVING COUNT(*) > 0 ORDER BY departures DESC',
 'fill_rate is already NULL on CUSTOM, on unsold private slots and before 2026-08-03, so the WHERE clause does the filtering for you. ALWAYS report the departures column next to the percentage: most products have fewer than fifteen and the rate is noise (limit small_n).'),

('departures_by_product',
 'how many tours did we run; how many departures of {product}',
 'SELECT product_code, product_kind, COUNT(*) AS slots_offered, COUNT(*) FILTER (WHERE is_real_departure) AS actually_ran, SUM(pax) AS pax
  FROM bc.departures WHERE departure_date < current_date GROUP BY 1,2 ORDER BY actually_ran DESC',
 'slots_offered counts open private capacity too. actually_ran is the honest number. The gap between them is large and is not a problem.'),

('revenue_by_channel',
 'revenue by channel; how much from GetYourGuide / Airbnb / direct; which channel earns most',
 'SELECT channel, COUNT(*) AS bookings, ROUND(SUM(gross_dkk)) AS gross_dkk, ROUND(AVG(gross_dkk)) AS avg_booking_dkk
  FROM bc.bookings GROUP BY 1 ORDER BY gross_dkk DESC',
 'GROSS of commission and of cancellations. GetYourGuide takes 30%, most other OTAs about 20%, direct 0%, so the ranking here is NOT the ranking by money kept. Say so every time.'),

('revenue_by_product',
 'revenue by tour / product; which tour makes the most money',
 'SELECT product_code, product_type, COUNT(*) AS bookings, ROUND(SUM(gross_dkk)) AS gross_dkk
  FROM bc.bookings GROUP BY 1,2 ORDER BY gross_dkk DESC',
 'Includes rentals (1-D to 14-D) alongside tours. Split them or say they are pooled. One large CUSTOM booking can dominate (limit one_big_booking).'),

('revenue_by_month_sold',
 'how much did we sell in {month}; sales by month',
 'SELECT strftime(booked_date_effective, ''%Y-%m'') AS ym, COUNT(*) AS bookings, ROUND(SUM(gross_dkk)) AS gross_dkk,
         COUNT(*) FILTER (WHERE booked_date_is_approx) AS approx_dated
  FROM bc.bookings WHERE booked_date_effective IS NOT NULL GROUP BY 1 ORDER BY 1',
 'This is SALES by when the booking was made, not by when the tour runs. approx_dated shows how many rows used the "first seen" fallback; it is high for rentals.'),

('guide_hours_by_person',
 'guide hours; how much has {guide} worked; who guided most',
 'SELECT guide_name, COUNT(*) AS departures, ROUND(SUM(buffered_hours), 1) AS buffered_hours, SUM(pax) AS pax
  FROM bc.guide_hours GROUP BY 1 ORDER BY buffered_hours DESC',
 'buffered_hours includes the buffer either side (30 min for F3/F3P, 15 for the rest), which is what the fleet app invoices on. It is NOT tour length. Departures with no assigned guide are absent entirely.'),

('bikes_out_on_date',
 'how many bikes are out on {date}; do we have enough bikes on {date}',
 'SELECT departure_date, SUM(total_bikes) AS bikes_needed, (SELECT COUNT(*) FROM bc.fleet_bikes WHERE active = 1) AS fleet_size
  FROM bc.departures WHERE departure_date = ${date} GROUP BY 1',
 'Tours only. Add bc.rental_slots for the full picture, but note that table is a rolling week-long cache. fleet_size is TODAY''S fleet: there is no history of bikes bought or retired.'),

('bike_type_demand',
 'which bike types are used most; demand by bike type',
 'SELECT b.bike_type_id, t.bike_type, SUM(b.bikes) AS bikes_allocated, COUNT(DISTINCT b.availability_id) AS departures
  FROM bc.departure_bikes b LEFT JOIN (SELECT DISTINCT bike_type_id, bike_type FROM bc.fleet_bikes) t USING (bike_type_id)
  GROUP BY 1,2 ORDER BY bikes_allocated DESC',
 'This is what was ALLOCATED, not what was collected. There is no no-show data.'),

('lead_time',
 'how far ahead do people book; booking lead time',
 'SELECT product_type, COUNT(*) AS bookings, ROUND(AVG(date_diff(''day'', booked_date, departure_date)), 1) AS avg_lead_days,
         ROUND(MEDIAN(date_diff(''day'', booked_date, departure_date)), 1) AS median_lead_days
  FROM bc.bookings WHERE booked_date IS NOT NULL AND departure_date IS NOT NULL GROUP BY 1',
 'Uses booked_date, NOT the effective fallback, so it only covers the 60% of bookings with a real creation timestamp. State that coverage. Using the fallback would compress old bookings to near-zero lead time and understate the answer.'),

('booking_pace',
 'is {product} filling up; how do bookings build before departure; booking pace',
 'SELECT product_code, days_before_departure, COUNT(*) AS changes, SUM(pax_delta) AS pax_added
  FROM bc.booking_pace WHERE days_before_departure BETWEEN 0 AND 60 AND pax_delta > 0
  GROUP BY 1,2 ORDER BY 1, 2 DESC',
 'Reconstructed from the archived change log, which starts 2026-07-07. This is the only way to answer pace at all; it exists only because bc-data archives what the fleet app deletes.'),

('sellouts',
 'which tours sold out; do we ever sell out',
 'SELECT product_code, departure_date, pax, capacity_effective
  FROM bc.departures
  WHERE pax_is_reliable AND capacity_effective IS NOT NULL AND pax >= capacity_effective
  ORDER BY departure_date DESC',
 'Uses >= not =, because private tours get overbooked on request. An empty result means no sellouts in the reliable window, which is a real answer, not a failure.'),

('empty_group_departures',
 'which tours ran empty; wasted departures; are we scheduling too many',
 'SELECT product_code, departure_date, start_time, guide
  FROM bc.departures
  WHERE product_kind = ''group_tour'' AND pax_is_reliable AND pax = 0 AND departure_date < current_date
  ORDER BY departure_date DESC',
 'GROUP TOURS ONLY, on purpose. An unsold private slot is open capacity, not an empty departure; including them is what made the old bc-brain briefing report "58 of 58 departures empty" as a finding.'),

('rentals_by_duration',
 'rental revenue by length; which rental durations sell; are long rentals worth it',
 'SELECT product_code AS rental_code, COUNT(*) AS bookings, ROUND(SUM(gross_dkk)) AS gross_dkk, ROUND(AVG(gross_dkk)) AS avg_dkk
  FROM bc.bookings WHERE product_type = ''rental'' GROUP BY 1 ORDER BY gross_dkk DESC',
 'The code is the number of days (1-D to 14-D). Rentals are roughly half of all bookings and half of gross revenue, so they deserve their own answer rather than being pooled with tours.'),

('reviews_by_guide',
 'reviews by guide; who gets the most reviews',
 'SELECT guide_name, COUNT(*) AS reviews, COUNT(DISTINCT channel) AS platforms, MIN(review_date) AS first_review, MAX(review_date) AS last_review
  FROM bc.guide_reviews GROUP BY 1 ORDER BY reviews DESC',
 'A COUNT of reviews logged, and nothing more. There is no star rating stored anywhere. A 50 DKK bonus is paid per five-star review and reviews are typed in by hand, so this measures guide effort at best, never customer satisfaction (limit review_survivorship).'),

('channel_mix_by_product',
 'where do bookings for {product} come from; channel mix by tour',
 'SELECT product_code, channel, COUNT(*) AS bookings, ROUND(SUM(gross_dkk)) AS gross_dkk
  FROM bc.bookings GROUP BY 1,2 ORDER BY product_code, bookings DESC',
 'Channels are different populations paying different prices; do not average across them without saying so (limit channel_selection).'),

('top_bookings',
 'biggest bookings; largest orders',
 'SELECT booking_ref, product_code, departure_date, channel, gross_dkk
  FROM bc.bookings ORDER BY gross_dkk DESC LIMIT 20',
 'Deliberately excludes customer name and email: aggregate by default (behaviour rule 8). Add them only if the question is explicitly about an identified customer.'),

('fleet_by_type',
 'what bikes do we have; fleet composition; how many e-bikes',
 'SELECT bike_type, COUNT(*) AS total, COUNT(*) FILTER (WHERE active = 1) AS active,
         COUNT(*) FILTER (WHERE status = ''out'') AS currently_out, MAX(rental_value_dkk) AS day_rate_dkk
  FROM bc.fleet_bikes GROUP BY 1 ORDER BY total DESC',
 'Present tense only. There is no history of acquisition or retirement, so this cannot be asked about a past date.'),

('open_repairs',
 'what is broken; open repair tickets; bikes in the workshop',
 'SELECT ticket_id, bike_id, bike_type_id, problem, status, opened_date, days_open
  FROM bc.repairs WHERE status = ''open'' ORDER BY days_open DESC',
 'Only 10 tickets exist in total and none since 2026-07-14. Report counts, never rates or averages.'),

('data_freshness',
 'how fresh is this data; when was this last updated; data as of',
 'SELECT loaded_at AS fleet_data_as_of, departures, bookings, earliest_departure, latest_departure FROM bc.data_freshness',
 'Must be quoted in every answer, for every source touched. The snapshot can be up to an hour behind the live app.');
