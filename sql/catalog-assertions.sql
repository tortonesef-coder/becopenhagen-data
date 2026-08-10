-- Deterministic checks, run on every load and every query result.
--
-- These are the layer that actually holds. A model reviewing its own SQL
-- catches syntax errors and absurd magnitudes; it does not catch join fan-out,
-- a filter that silently dropped a month, or the wrong date column, because
-- those look correct to the thing that produced them.
--
-- BOUNDS ARE MEASURED, NOT GUESSED. The spec proposed round numbers written
-- without access to the data; every one below was recomputed against the real
-- warehouse on 2026-08-10 and bounds_source records which is which. Where the
-- spec's number was off by orders of magnitude, the spec's number is recorded
-- in the message so the change is visible rather than silent.
--
-- severity: block means report the violation INSTEAD of the number. warn means
-- report the number with the warning attached. Being too eager with block makes
-- the tool useless; being too shy makes it dangerous. Each choice is argued.

DELETE FROM catalog.assertions;

INSERT INTO catalog.assertions (assertion_key, target, expression, message, severity, bounds_source) VALUES

-- ── BLOCK: the ones that would produce a confidently wrong answer ───────────
('pax_before_2026_08_03', 'bc.departures',
 'NOT EXISTS (SELECT 1 FROM bc.departures WHERE NOT pax_is_reliable AND pax > 0)',
 'Passenger counts on departures before 2026-08-03 are zero and WRONG: the departure rows for tours that actually sold were deleted from the live fleet database (179 of 180 July tour bookings point at an availability that no longer exists). Report the hole, do not report the number. bc.departures_recovered has a best-effort reconstruction that over-counts by about 43%.',
 'block', 'measured'),

('no_july_occupancy', '*',
 'NOT (result_covers_dates_before(''2026-08-03'') AND result_mentions(''fill_rate'',''occupancy'',''pax''))',
 'Any occupancy or passenger figure covering dates before 2026-08-03 is meaningless. Say the data does not exist for that period instead of returning a number.',
 'block', 'measured'),

('history_horizon', '*',
 'NOT result_covers_dates_before(''2026-06-28'')',
 'Nothing in this warehouse predates 2026-06-28. A query returning rows before that date has a bug, most likely a date column parsed wrong. (The spec proposed 2019-01-01 as the company-start bound; that was written before anyone had read the schema and would pass trivially.)',
 'block', 'measured'),

('fill_rate_is_a_proportion', 'bc.departures',
 'NOT EXISTS (SELECT 1 FROM bc.departures WHERE fill_rate < 0 OR fill_rate > 1.5)',
 'Fill rate outside 0 to 1.5 means the capacity denominator is wrong. Observed range is 0.0 to 1.0 across 369 departures. The 1.5 ceiling rather than 1.0 is deliberate: Fede overbooks private tours on request, so a genuine 1.0+ is possible.',
 'block', 'measured'),

('no_net_revenue', '*',
 'NOT result_mentions(''net revenue'',''margin'',''profit'',''after commission'')',
 'Net revenue is not computable: the actual commission charged per booking is not in this warehouse (gap ota_commission_actual). Applying an assumed rate to gross produces a fabricated number. Say it cannot be computed.',
 'block', 'stated_by_fede'),

('no_cross_schema_arithmetic', '*',
 'NOT (query_touches_schema(''bc'') AND query_touches_schema(''dst''))',
 'Never compute a ratio or join across bc.* and dst.*. The denominators are different populations, so "we captured 0.4% of Copenhagen visitors" is a fabricated number. Comparing the two in words is not only allowed, it is the point.',
 'block', 'stated_by_fede'),

-- ── WARN: real but not necessarily wrong ───────────────────────────────────
('pax_within_capacity', 'bc.departures',
 'NOT EXISTS (SELECT 1 FROM bc.departures WHERE pax_is_reliable AND capacity_effective IS NOT NULL AND pax > capacity_effective)',
 'A departure carrying more people than its capacity. Deliberately a WARN and not a block: Fede overbooks private tours when a group emails to ask, so this is a real business practice, not a data error. Worth surfacing, never worth refusing to answer over.',
 'warn', 'stated_by_fede'),

('small_n_fill_rate', '*',
 'result_departure_count() >= 15',
 'A fill rate computed over fewer than fifteen departures is noise, not a rate. As of 2026-08-10 only A3 has reached double figures of completed departures, so this fires on almost every per-product occupancy question. Report the raw counts instead.',
 'warn', 'measured'),

('revenue_per_booking_plausible', 'bc.bookings',
 'NOT EXISTS (SELECT 1 FROM bc.bookings WHERE gross_dkk > 25000)',
 'A booking above 25,000 DKK. Observed maximum is 19,300 (a tour) and 10,800 (a rental), so this is high but not impossible for a large CUSTOM group. Check it is not a parse error before quoting it. (The spec proposed 50,000; measured data does not support a bound that loose.)',
 'warn', 'measured'),

('zero_value_bookings', 'bc.bookings',
 'NOT EXISTS (SELECT 1 FROM bc.bookings WHERE gross_dkk = 0)',
 'Six bookings have a value of exactly 0 DKK (4 direct, 2 Airbnb). Probably comps or corrections rather than errors, but they drag any average down and should be named when reporting revenue per booking.',
 'warn', 'measured'),

('monthly_pax_plausible', '*',
 'result_max_monthly_pax() BETWEEN 0 AND 2000',
 'A month above 2,000 passengers is far outside anything observed: the busiest month on record is August 2026 at 294. A figure that large is more likely a join fan-out than a record month. (The spec proposed 5,000, which is about seventeen times the real peak and would never fire.)',
 'warn', 'measured'),

('bikes_within_fleet', 'bc.departures',
 'NOT EXISTS (SELECT 1 FROM (SELECT departure_date, SUM(total_bikes) b FROM bc.departures GROUP BY 1) WHERE b > 104)',
 'More bikes allocated on one day than the fleet holds (104 active as of 2026-08-10). Peak observed is 65 on 2026-10-02, a large CUSTOM booking. NOTE: this bound cannot be made date-aware, because there is no history of when bikes were bought or retired (gap fleet_history), so it uses today''s fleet size for every date.',
 'warn', 'measured'),

('recovered_departures_overcount', 'bc.departures_recovered',
 'NOT query_touches_table(''bc.departures_recovered'')',
 'bc.departures_recovered over-counts by about 43% (measured against August, where the live data is ground truth: 288 departures / 294 pax actual versus 455 / 421 reconstructed), because FareHarbor reissues availability IDs. Use it to say a period existed and roughly how it went, never for a precise figure, and always state the over-count.',
 'warn', 'measured'),

('gross_not_net', 'bc.bookings',
 'NOT query_touches_column(''gross_dkk'')',
 'Every revenue figure is gross of OTA commission (GetYourGuide 30%, most others about 20%) AND gross of cancellations, since no cancellation flag exists. Say so alongside the number.',
 'warn', 'stated_by_fede'),

('unsold_private_slots', 'bc.departures',
 'NOT (query_touches_table(''bc.departures'') AND NOT query_filters_on(''is_real_departure''))',
 'About two thirds of departure rows are unsold private slots, which are open capacity rather than tours that ran empty. A query over bc.departures that does not filter on is_real_departure will report every private product as roughly 0% sold. This exact mistake has already produced a wrong finding in the earlier bc-brain briefings.',
 'warn', 'measured'),

('stale_snapshot', 'bc.fleet_snapshot',
 'EXISTS (SELECT 1 FROM bc.data_freshness WHERE loaded_at > now() - INTERVAL 3 HOUR)',
 'The fleet snapshot is more than three hours old, so the hourly refresh has probably stopped. The refresh runs at :35 past each hour and normally takes about three seconds. Check /var/lib/bc-data/logs/refresh.log.',
 'warn', 'measured');
