-- The business dictionary. Injected into the system prompt on every call.
--
-- Separate file from catalog-seed.sql because this is the one table Fede and
-- Søren edit themselves, from the Dictionary page (phase 7). Re-running this
-- file restores the seeded wording, so it must only be run deliberately, never
-- as part of a deploy. Rows edited by a human (updated_by not 'claude (seed)')
-- are left alone.
--
-- Every entry answers: what does this word mean, what SQL expresses it, and
-- what is the plausible-but-wrong thing someone will write instead.

DELETE FROM catalog.definitions WHERE updated_by = 'claude (seed)';

INSERT INTO catalog.definitions (term, definition, sql_snippet, do_not_use, updated_at, updated_by) VALUES

-- ── THE MANDATORY FIRST ENTRY ───────────────────────────────────────────────
('in July',
 'A month named on its own means the month the TOUR RAN (departure date), not the month the booking was taken. "How many pax in July" is answered on departure_date. When someone means sales, they say "booked in July" or "sold in July", which is the separate term below. If the phrasing is genuinely ambiguous, answer BOTH and say they are different questions.
CHOSEN BECAUSE: departure_date is populated on 100% of rows, while the booking-created date is missing on 40% (286 of 710), almost all rentals. Answering on booking date silently drops most of the rental business. Revisit this when phase 5 brings in the FareHarbor history, where booked_at is fully populated.',
 'WHERE departure_date BETWEEN DATE ''2026-07-01'' AND DATE ''2026-07-31''',
 'Do not use booked_date for a bare month name. And never use booked_date without falling back to booked_date_effective, or you drop 40% of bookings with no warning.',
 now(), 'claude (seed)'),

('booked in July',
 'The month the SALE was made, regardless of when the tour runs. Use booked_date_effective, which falls back to when our sync first spotted the booking (usually within 90 seconds) for the 40% of rows that have no real creation timestamp. Always say when the approximate fallback was used.',
 'WHERE booked_date_effective BETWEEN DATE ''2026-07-01'' AND DATE ''2026-07-31''',
 'Do not use booked_date alone: it is NULL on 286 of 710 rows and the result will silently exclude nearly every rental.',
 now(), 'claude (seed)'),

-- ── COUNTING PEOPLE AND SALES ───────────────────────────────────────────────
('pax',
 'People. Passengers on a tour. On bc.departures the pax column is FareHarbor''s customer_count, which is people, not reservations: one booking of eleven people is 11 pax and 1 booking.',
 'SELECT SUM(pax) FROM bc.departures WHERE pax_is_reliable',
 'Never count rows in bc.bookings and call it pax. A booking is not a person and bc.bookings has no pax column at all.',
 now(), 'claude (seed)'),

('booking',
 'One reservation, one row in bc.bookings, identified by booking_ref. Covers tours and rentals. Includes cancelled bookings, because nothing in this data records a cancellation.',
 'SELECT COUNT(*) FROM bc.bookings',
 'Do not use bc.departures.pax as a booking count: that is people. Do not assume cancelled bookings are excluded, they are not, and they cannot be.',
 now(), 'claude (seed)'),

('departure',
 'One scheduled tour slot, sold or unsold, one row in bc.departures. This is the only place unsold departures exist. A private slot with zero bookings is NOT a departure that ran empty, it is open capacity nobody booked, so filter on is_real_departure for anything about how tours performed.',
 'SELECT COUNT(*) FROM bc.departures WHERE is_real_departure',
 'Do not count every row in bc.departures as a tour that ran. Roughly two thirds are unsold private slots.',
 now(), 'claude (seed)'),

('rental',
 'A bike hire, not a tour. Product codes 1-D through 14-D, where the number is the number of days. Rentals must be excluded from any tour analysis unless the question is about rentals.',
 'WHERE product_type = ''rental''',
 'Do not pool rentals with tours in a revenue or volume figure without saying so. Rentals are roughly half of all bookings.',
 now(), 'claude (seed)'),

-- ── OCCUPANCY ───────────────────────────────────────────────────────────────
('fill rate',
 'Passengers divided by capacity, for departures that genuinely ran. Precomputed as fill_rate on bc.departures and deliberately NULL wherever the denominator cannot be trusted: on CUSTOM (no capacity limit exists), on unsold private slots (open capacity, not an empty tour), and on anything before 2026-08-03 (passenger counts are zero and wrong).',
 'SELECT ROUND(AVG(fill_rate)*100,1) FROM bc.departures WHERE fill_rate IS NOT NULL AND departure_date < current_date',
 'Do not compute pax/capacity yourself: you will include the cases the precomputed column deliberately excludes. Do not average a fill rate over fewer than about fifteen departures, which as of 2026-08-10 rules out every product except A3.',
 now(), 'claude (seed)'),

('occupancy',
 'The same thing as fill rate in this business. Use fill rate and say so, rather than introducing a second word for one number.',
 'See fill rate.',
 'Do not compute occupancy from bc.bookings: a bookings table only contains departures that SOLD, so every empty departure is invisible and demand is overstated.',
 now(), 'claude (seed)'),

('capacity',
 'How many people fit on a departure. Comes from FareHarbor per departure where it is set (432 departures), falls back to Fede''s stated default otherwise (708). capacity_source says which. L2P, L3P, F3P and H3P have NO capacity set in FareHarbor at all, so they always use the stated 16. CUSTOM has no limit.',
 'SELECT capacity_effective, capacity_source FROM bc.departures',
 'Never use bookable_capacity from the FareHarbor payload as capacity: it counts free BIKES, not seats, and reaches 74 on L2P. It would make fill rate meaningless.',
 now(), 'claude (seed)'),

('sellout',
 'A departure where pax reached capacity. Given the overbooking practice on private tours, treat pax >= capacity as sold out rather than exactly equal.',
 'WHERE pax_is_reliable AND capacity_effective IS NOT NULL AND pax >= capacity_effective',
 'Do not call a private slot with one booking a sellout just because fill_rate is NULL.',
 now(), 'claude (seed)'),

-- ── MONEY ───────────────────────────────────────────────────────────────────
('revenue',
 'Gross booking value in DKK, from bc.bookings.gross_dkk. GROSS in two distinct ways that must both be stated: gross of OTA commission (GetYourGuide takes 30%, most other OTAs about 20%, direct is 0%), and gross of cancellations, because no cancellation flag exists anywhere in this data.',
 'SELECT SUM(gross_dkk) FROM bc.bookings',
 'Never call this profit, margin, net or take-home. Never subtract an assumed commission rate to produce a "net" figure and present it as measured: the real commission per booking is a known gap.',
 now(), 'claude (seed)'),

('net revenue',
 'NOT AVAILABLE. The actual commission charged per booking is not in this warehouse. It is in the FareHarbor sales report and is logged as gap ota_commission_actual. Say it cannot be computed rather than applying an assumed rate.',
 NULL,
 'Do not multiply gross by (1 - assumed rate) and call the result net revenue. That is a fabricated number.',
 now(), 'claude (seed)'),

('revenue per pax',
 'Gross booking value divided by people. Only computable for tours, and only from 2026-08-03, because pax is not reliable before then and bc.bookings has no pax column of its own.',
 'Join bc.bookings to bc.departures on availability_id, then SUM(gross_dkk)/SUM(pax) over departures where pax_is_reliable.',
 'Do not divide revenue by booking count and call it revenue per pax. That is revenue per booking, a different number, larger for groups.',
 now(), 'claude (seed)'),

('channel',
 'Where the booking came from: direct, GetYourGuide, Airbnb, TripAdvisor or Viator. On bc.bookings this is the channel column, defaulting to direct when blank.',
 'SELECT channel, COUNT(*), SUM(gross_dkk) FROM bc.bookings GROUP BY 1',
 'Do not pool channels in a customer-behaviour comparison: they are different populations who paid different prices under different conditions (limit channel_selection).',
 now(), 'claude (seed)'),

-- ── PRODUCTS ────────────────────────────────────────────────────────────────
('tour',
 'A guided bike tour. Group tours are A3 architecture, L3 liveability, F3 food, H3 history, plus A3G German and A3F French. Excludes rentals.',
 'WHERE product_kind IN (''group_tour'', ''private_tour'', ''custom_tour'')',
 'Do not include 1-D through 14-D. Those are bike rentals.',
 now(), 'claude (seed)'),

('private tour',
 'A tour bought whole by one group: A3P, L3P, F3P, H3P, L2P, and CUSTOM. Sold at a max of 16, which Fede will exceed on request, so capacity here is soft. Most private slots sit open and unsold by design.',
 'WHERE is_private',
 'Do not count unsold private slots as failed departures. Roughly two thirds of all departure rows are open private capacity and counting them as empty makes every private product read as 0% sold, which has already produced a wrong finding once.',
 now(), 'claude (seed)'),

('group tour',
 'A public scheduled departure where strangers buy individual seats: A3, L3, F3, H3, A3G, A3F. The only product type where fill rate means what people expect it to mean.',
 'WHERE product_kind = ''group_tour''',
 'Do not average fill rate across group and private tours together. They mean different things.',
 now(), 'claude (seed)'),

-- ── PEOPLE AND TIME ─────────────────────────────────────────────────────────
('guide hour',
 'Buffered wall time a guide is paid for, not tour length. F3 and F3P carry 30 minutes either side, everything else 15, so a 3 hour tour bills as 3.5 hours. This is the figure the fleet app invoices on.',
 'SELECT guide_name, SUM(buffered_hours) FROM bc.guide_hours GROUP BY 1',
 'Do not report buffered_hours as how long a tour lasts. Do not use bc.guide_hours to count departures: unassigned departures are missing from it entirely.',
 now(), 'claude (seed)'),

('lead time',
 'Days between the booking being made and the tour running. Only computable for the 60% of bookings with a real creation date, so state the coverage whenever you report it.',
 'SELECT date_diff(''day'', booked_date, departure_date) FROM bc.bookings WHERE booked_date IS NOT NULL',
 'Do not use booked_date_effective for lead time without saying so: for the approximate rows it measures when our sync noticed, which compresses genuinely old bookings to near zero.',
 now(), 'claude (seed)'),

('no-show', 'NOT AVAILABLE. Nothing in this data records whether a booked passenger turned up.', NULL,
 'Do not infer no-shows from any difference between bookings and bikes. Bike counts are what was allocated, not what was collected.',
 now(), 'claude (seed)'),

('cancellation', 'NOT AVAILABLE in this warehouse. bc.bookings has no cancellation flag: a cancelled booking stops appearing in the feed and its row remains unchanged forever. Logged as gap cancellations.', NULL,
 'Do not treat a stale last_seen_at as a cancellation. Do not use was_marked_cancelled on bc.departures_recovered as proof: the fleet app has logged false cancellations before.',
 now(), 'claude (seed)'),

('active bike',
 'A bike marked active in the fleet, 104 as of 2026-08-10. Present tense only: there is no history of when bikes were bought or retired, so fleet size on any past date is not computable.',
 'SELECT COUNT(*) FROM bc.fleet_bikes WHERE active = 1',
 'Do not compute fleet size for a past date. Do not read bikes.created_at as a purchase date: it is when the row was typed in during the 2026-06-28 setup.',
 now(), 'claude (seed)'),

('data as of',
 'The timestamp of the hourly snapshot everything is built from, in bc.data_freshness.loaded_at. Must appear in every answer, for every source touched.',
 'SELECT loaded_at FROM bc.data_freshness',
 'Do not say "as of today" or "currently". Quote the actual timestamp: the data can be up to an hour behind the live app.',
 now(), 'claude (seed)');
