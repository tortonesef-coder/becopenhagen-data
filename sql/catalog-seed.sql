-- Catalog seed. Everything phases 0 and 1 learned the hard way, written down
-- so it is never learned again.
--
-- DELETE + INSERT per table rather than upsert, on purpose: this file is the
-- source of truth for the SEEDED rows and re-running it must produce exactly
-- the state in git. Fede's own edits (definitions he changes in the Dictionary
-- page, gap citation counts) are protected by the guards below, which skip
-- rows a human has touched. catalog.query_log is never touched by this file.

-- ── SOURCES ─────────────────────────────────────────────────────────────────
DELETE FROM catalog.sources;
INSERT INTO catalog.sources
  (source_key, display_name, schema_name, layer, description, grain,
   refresh_cadence_hours, retrieval_method, retrieval_instructions, gotchas, owner)
VALUES
('bc.departures', 'Tour departures', 'bc', 'view',
 'Every tour departure that was OFFERED, whether it sold or not. Rebuilt hourly from a read-only snapshot of the live fleet database.',
 'One row per tour departure (one availability in FareHarbor).',
 1, 'auto', 'Automatic. scripts/refresh.sh at :35 past every hour.',
 'PAX IS ZERO AND WRONG BEFORE 2026-08-03. The departure rows for July tours that actually sold were deleted from the live database: 179 of 180 July tour bookings point at an availability_id that no longer exists. What survives for July is mostly private slots that never sold, so July reads as "93 departures, 0 passengers". Always check pax_is_reliable. See bc.departures_recovered for the best-effort reconstruction.
booking_count means PEOPLE here (FareHarbor customer_count), but RESERVATIONS on rentals, which is why rentals are a separate table.
A private slot with 0 bookings is open capacity, not a departure that ran empty. Filter on is_real_departure or every private product reads as ~0% sold.
capacity comes from FareHarbor per departure where known, otherwise Fede''s stated default. Check capacity_source before quoting a fill rate.
Past departures are frozen by the fleet app: once the day passes the row stops updating, so a late correction never lands.',
 'fede'),

('bc.departures_recovered', 'Recovered departures (best effort)', 'bc', 'view',
 'Departures reconstructed from the archived change log, including ones deleted from the live database. The only surviving trace of July.',
 'One row per availability_id ever seen in the change log.',
 1, 'auto', 'Automatic, same hourly job.',
 'OVER-COUNTS BY ABOUT 43%. Measured against August, where live data is ground truth: live says 288 departures / 294 pax, this table says 455 / 421. FareHarbor reissues an availability ID whenever a private tour is edited, so one real departure appears under several IDs, and deduping needs start_time which the change log does not record.
Use it to say "July existed and sold roughly this much". NEVER quote a precise figure from it, and ALWAYS state the over-count when you do use it.
was_marked_cancelled is not proof of cancellation: the fleet app has logged false cancellations before (nine phantom A3P cancel emails in a single sync).',
 'fede'),

('bc.bookings', 'Booking ledger', 'bc', 'view',
 'The permanent record of every booking, tours and rentals. The fleet app never deletes from it.',
 'One row per booking reference.',
 1, 'auto', 'Automatic, same hourly job.',
 'THERE IS NO CANCELLATION FLAG. A cancelled booking simply stops appearing in the feed and its row stays here forever, unchanged. Every revenue figure from this table is gross of cancellations AND gross of OTA commission (GetYourGuide takes 30%, most other OTAs about 20%).
gross_dkk is parsed from a TEXT column that literally reads "DKK1,200.00". Verified to total 952,589 DKK with zero parse failures on 2026-08-10.
booked_date is NULL on 40% of rows (286 of 710), overwhelmingly rentals, because rental and Airbnb bookings never fire the FareHarbor webhook. booked_date_effective falls back to when our sync first spotted it, usually within 90 seconds, and booked_date_is_approx says which you got.
There is no pax column. A booking is not a person. Use bc.departures for people.
Starts 2026-07-01. There is no history before that anywhere in this warehouse.',
 'fede'),

('bc.booking_pace', 'Booking pace', 'bc', 'view',
 'Every real movement in a departure''s passenger count, with how many days before departure it happened. Reconstructed from the archived change log.',
 'One row per observed change in booking_count for a departure.',
 1, 'auto', 'Automatic, same hourly job.',
 'Only exists because bc-data archives the fleet log tables; the live app deletes them after 120 days and the first deletion would have been 2026-10-26.
Identical consecutive values are collapsed. The fleet app has a known bug that relogs an unchanged value every 90 seconds, so raw log rows massively overstate real activity: 283,928 rows reduce to a few thousand actual changes.
Starts 2026-07-07, when the change log itself starts.',
 'fede'),

('bc.rental_slots', 'Rental slots', 'bc', 'view',
 'Rental reservations by pickup date, from the fleet app''s availability cache.',
 'One row per rental availability.',
 1, 'auto', 'Automatic, same hourly job.',
 'reservations means BOOKINGS here, not people and not bikes. Same underlying column as pax on tours, opposite meaning.
This is a short rolling cache, roughly a week back. bc.bookings is the durable rental record; do not use this table for anything historical.
rental_code is the duration: 1-D through 14-D.',
 'fede'),

('bc.guide_hours', 'Guide hours', 'bc', 'view',
 'Hours worked per guide per departure, as the fleet app computes them for invoicing.',
 'One row per departure with an assigned guide.',
 1, 'auto', 'Automatic, same hourly job.',
 'buffered_minutes is WALL TIME INCLUDING BUFFER, not tour length. F3 and F3P carry 30 minutes either side, everything else 15. A 3 hour tour bills as 3.5 hours.
Only departures with an assigned guide appear. An unassigned departure is missing entirely, so this is not a source for counting departures.
Zero-booking private tours are excluded by the fleet app before they ever reach here.',
 'fede'),

('bc.guide_reviews', 'Guide reviews', 'bc', 'view',
 'Customer reviews logged against a guide, by platform.',
 'One row per logged review.',
 1, 'auto', 'Automatic, same hourly job.',
 'NOT A SATISFACTION MEASURE, AND NOT A RATING. There is no star rating stored at all. A 50 DKK bonus is paid per five-star review, which biases the sample twice over: which customers get asked, and which reviews get logged. Review COUNT measures guide effort at best.
Reviews are entered by hand, so absence means nobody typed it in, not that nobody reviewed.',
 'fede'),

('bc.fleet_bikes', 'Fleet', 'bc', 'view',
 'The bikes, their types and current status.',
 'One row per bike.',
 1, 'auto', 'Automatic, same hourly job.',
 'POINT IN TIME ONLY. There is no history of acquisition or retirement anywhere: created_at is when the row was typed in during the 2026-06-28 setup, and retirement is a flag with no date. "How many bikes did we have in March" is NOT answerable, and any assertion phrased as fleet size on a past date cannot be computed.
104 bikes are active as of 2026-08-10.
status is live and changes minute to minute; it is not an as-of-date field.',
 'fede'),

('bc.repairs', 'Repair tickets', 'bc', 'view',
 'Mechanic tickets against bikes.',
 'One row per repair ticket.',
 1, 'auto', 'Automatic, same hourly job.',
 'Only 10 tickets exist in total and none since 2026-07-14. This is far too few for any rate, average or per-bike-type comparison. Report counts, never percentages.',
 'fede'),

('bc.products', 'Products', 'bc', 'view',
 'The tour codes, their names, and whether they are private.',
 'One row per tour product code.',
 1, 'auto', 'Hand maintained in sql/build-warehouse.sql. The FareHarbor item to tour-code mapping lives in the fleet app''s source, not in any database.',
 'stated_capacity is Fede''s answer of 2026-08-10 and is a FALLBACK, not a measurement. Real capacity is per departure on bc.departures.
A3F and H3P have never run. They are not retired, they just have no departures yet, so exclude them by checking departure count rather than assuming they are dead.
CUSTOM has no capacity limit at all, so it has no fill rate.',
 'fede'),

('bc.departure_bikes', 'Bikes per departure', 'bc', 'view',
 'The bikes_needed JSON on each departure, unnested to one row per bike type, so bike demand can be grouped.',
 'One row per departure per bike type with a non-zero count.',
 1, 'auto', 'Automatic, same hourly job.',
 'These are bikes ALLOCATED, not bikes collected. There is no no-show data, so this cannot tell you what actually went out of the door.
Bike type codes: A adult, SA small adult, TB touring, E electric, GT/GTS guided tour, CC Christiania cargo, MB mountain, AC adult with child seat, AT adult with toddler seat, B/BM child bikes.
Tour bike counts come from FareHarbor resources (what was actually assigned); rental counts come from parsing booking text (what the customer ordered). They are not equally reliable.',
 'fede'),

('bc.dialling_codes', 'Dialling code lookup', 'bc', 'view',
 'Maps an international phone prefix to a country and market label. Hand maintained, longest prefix wins.',
 'One row per country dialling code.',
 1, 'auto', 'Hand maintained in sql/build-warehouse.sql. Add a prefix when an unmatched one shows up.',
 'This is a LOOKUP, not customer data. It exists so bc.bookings.customer_market can be derived.
Longest prefix must win: +45 is Denmark, not "+4" something. The join in build-warehouse.sql orders by prefix length descending for exactly this reason.',
 'fede'),

('bc.daily_bike_load', 'Daily bike load', 'bc', 'view',
 'How many bikes were needed each day across tours and rentals, against the size of the fleet. The bikes half of capacity utilisation (amendment section 6); the seats half is fill_rate on bc.departures.',
 'One row per date on which anything was scheduled.',
 1, 'auto', 'Automatic, same hourly job.',
 'THE DENOMINATOR IS TODAY''S FLEET, FOR EVERY DATE. There is no history of when bikes were bought or retired (gap fleet_history), so a utilisation figure for a past date divides by a fleet size that may not have existed then. Directionally useful, precisely wrong: say so when quoting it.
bikes_out is what was ALLOCATED, not what left the shop. There is no no-show data.
Tour bike counts come from FareHarbor resources (what was actually assigned); rental counts come from parsing booking text (what the customer ordered). They are not equally reliable, and this table sums them.
Peak observed is 65 bikes on 2026-10-02, a single large CUSTOM booking, against 104 active bikes.',
 'fede'),

('bc.guide_identity', 'Guide name resolution', 'bc', 'view',
 'Maps every spelling of a guide''s name ever seen in any system to one canonical team member id.',
 'One row per distinct guide name string found anywhere in the data.',
 1, 'auto', 'Automatic, same hourly job. Built by scripts/resolve-guides.js.',
 'Guide names are typed by hand into FareHarbor crew notes, so the same person appears as "Federico Tortonese", "Federico" and worse. ALWAYS join guide questions on guide_id, never on the name string, or someone''s hours silently go missing from the total.
The matching rules are ported from the fleet app''s own matcher (accents, known aliases such as Hasse for Hassan and Pam for Paloma, Levenshtein for typos) so the two apps agree on who is who.
match_method = ''unresolved'' means the name reached nobody. That is a WARNING, not a build failure: a typo in a crew note must never freeze the hourly refresh. Those rows still carry the raw name, but they will not group with a person, so any per-guide total is short until someone adds the spelling.',
 'fede'),

('bc.departure_capacity', 'Harvested capacity', 'bc', 'view',
 'Per-departure seat capacity, mined out of the raw FareHarbor payloads that the fleet scraper writes to its change log and then discards.',
 'One row per availability_id that ever appeared in a FareHarbor payload.',
 1, 'auto', 'Automatic, same hourly job. Read from the permanent archive, not the live database.',
 'fh_capacity_seats is NULL for most private products (L2P, L3P, F3P, H3P have no seat limit configured in FareHarbor at all). NULL means "no limit set", NOT zero.
NEVER use fh_bookable_capacity_bikes as a capacity denominator. It counts free BIKES rather than seats and reaches 74 on L2P, which would make fill rate meaningless.
Mined by regex, not JSON parsing, because the source payloads are truncated at 4000 characters and many do not parse.',
 'fede'),

('bc.team', 'Team members', 'bc', 'view',
 'Staff and guides, from the fleet app''s own user table.',
 'One row per team member.',
 1, 'auto', 'Automatic, same hourly job.',
 'Includes inactive members; filter on active. is_guide marks who actually guides, which is not the same as role: Federico is an admin AND a guide.
Guide names in bc.guide_hours are free text from FareHarbor crew notes and do not always match name here exactly, which is why the fleet app carries a fuzzy matcher.',
 'fede'),

('bc.data_freshness', 'Freshness', 'bc', 'view',
 'One row saying when the snapshot everything is built from was taken, and the headline row counts.',
 'A single row.',
 1, 'auto', 'Automatic, same hourly job.',
 'loaded_at must be quoted in every answer. The snapshot can be up to an hour behind the live booking app, so a booking taken ten minutes ago will not be here yet.',
 'fede'),

('bc.fleet_snapshot', 'Fleet database snapshot', 'bc', 'raw',
 'The hourly read-only copy of the live fleet SQLite database that everything above is built from.',
 'One SQLite file.',
 1, 'auto', 'Automatic. scripts/snapshot-fleet.sh. To force one: /var/www/becopenhagen-data/scripts/refresh.sh',
 'Up to one hour stale by design. bc.data_freshness carries the exact timestamp and every answer must state it.
The fleet database itself only starts 2026-06-28. There is NO data before that date in this system at all.',
 'fede');

-- ── LIMITS ──────────────────────────────────────────────────────────────────
-- Inferential traps. Checked before any causal-sounding sentence.
DELETE FROM catalog.limits;
INSERT INTO catalog.limits (limit_key, rule, applies_to) VALUES
('supply_not_demand',
 'Four departures with low fill is not a measurement of demand, it is a measurement of what was scheduled. Before concluding anything about appetite, check whether departures existed at all. Scheduled-and-empty is evidence of low demand; not-scheduled is no evidence either way.',
 'any question about demand, interest, popularity, or a product doing badly'),

('small_n',
 'A fill rate over fewer than about fifteen departures is noise. Say so instead of reporting it as a rate. This bites constantly here: as of 2026-08-10 only A3 has reached double figures of completed departures, and most products have one or two.',
 'fill rate, occupancy, conversion, any per-product or per-guide average'),

('review_survivorship',
 'A 50 DKK bonus is paid per five-star review, and reviews are logged by hand. The sample is biased twice and there is no star rating stored at all. Review counts are a measure of guide effort, never of customer satisfaction.',
 'anything using bc.guide_reviews'),

('channel_selection',
 'GetYourGuide, Viator, Airbnb and direct customers are different populations who booked under different conditions and paid different prices. Pooling them hides the thing worth knowing. Segment, or say explicitly that you pooled them.',
 'revenue, conversion, cancellation, lead time, any customer-behaviour question'),

('seasonality_not_trend',
 'Month-over-month movement in this business is mostly weather and calendar. Compare like months across years, not adjacent months. NOTE: this warehouse holds six weeks of data and cannot do that at all, so the honest answer to almost any trend question is that it cannot be answered yet, not a month-over-month number with a caveat attached.',
 'trend, growth, decline, "is it getting better", any month-over-month comparison'),

('history_starts_june_2026',
 'Nothing in this warehouse predates 2026-06-28, and departure passenger counts are only trustworthy from 2026-08-03. Any question about last year, last season, or year-on-year cannot be answered from this data. Say that plainly rather than answering from the few weeks available. The longer history exists in FareHarbor and is planned for phase 5.',
 'every question containing a year, a season, "last", "usually", "normally", or "trend"'),

('one_big_booking',
 'A single large CUSTOM or private booking can dominate a week or a month. CUSTOM has carried up to 65 people on one departure. Before calling anything a trend, check whether one booking is carrying it.',
 'revenue by week or month, any total that moved sharply'),

('gross_not_net',
 'Every revenue figure here is gross: gross of OTA commission (GetYourGuide 30%, most others about 20%) and gross of cancellations, because no cancellation flag exists. Never present a gross figure as profit, margin or take-home.',
 'revenue, sales, income, "how much did we make"');

-- ── GAPS ────────────────────────────────────────────────────────────────────
-- ON CONFLICT rather than DELETE + INSERT, because cited_count is EARNED at
-- runtime: every time the agent cites a gap it increments, and that count is
-- what ranks the data roadmap. Deleting and reinserting would reset the roadmap
-- to zero on every deploy. The earlier "DELETE WHERE cited_count = 0" was worse
-- than useless: it left any gap that had ever been cited in place and then hit
-- a primary key violation on reinsert, so the whole seed file aborted.
INSERT INTO catalog.gaps (gap_key, missing, unlocks, how_to_get, effort) VALUES
('history_pre_2026',
 'Any booking, revenue or departure data before 2026-06-28.',
 'Year-on-year, season-on-season, and every trend question. This is the single biggest hole in the system.',
 'FareHarbor exports it: the bookings (detailed), sales and customers reports, run on Booking created date. Planned for phase 5.',
 'medium'),
('july_departures',
 'Departure records for July 2026, deleted from the live database.',
 'A true July occupancy figure, and a first month-on-month comparison.',
 'Partly reconstructable from the archive already (bc.departures_recovered, +43% over-count). A FareHarbor export would settle it exactly.',
 'medium'),
('guide_cost_per_tour',
 'What each guide is actually paid per departure.',
 'Contribution margin per product, and whether private tours are worth running.',
 'Guide invoices are uploaded as PDFs but never parsed. Payroll export tagged by tour code would do it.',
 'medium'),
('ota_commission_actual',
 'The real commission charged per booking, rather than the assumed rate.',
 'True net revenue by channel, and whether GetYourGuide at 30% is worth it.',
 'The FareHarbor sales report carries it. Phase 5.',
 'low'),
('cancellations',
 'Which bookings were cancelled, and when.',
 'Real revenue instead of gross, plus cancellation rate by channel and lead time.',
 'The FareHarbor bookings report has a Cancelled? column. Nothing in the fleet database records it. Phase 5.',
 'low'),
('fleet_history',
 'When each bike was bought and when it was retired.',
 'Fleet utilisation over time, and cost per bike per rental.',
 'Nowhere digital. Would have to be reconstructed from purchase records by hand.',
 'high'),
('marketing_spend',
 'What was spent per channel per month.',
 'Cost of acquisition, and whether direct bookings are actually cheaper than OTA.',
 'Ad platform exports plus the bank. Out of v1 scope by decision.',
 'medium'),
('weather',
 'Weather at each departure time.',
 'Separating weather from demand, which limit seasonality_not_trend says is the main confound in this business.',
 'DMI open data, or Danmarks Statistik. Joinable on departure date once the history exists.',
 'low'),
('bike_type_per_booking',
 'Which bike type each customer actually took on a rental.',
 'Which bikes earn their keep, and what to buy next.',
 'The FareHarbor customers report has it (bike_type per line item). Phase 5.',
 'low')
ON CONFLICT (gap_key) DO UPDATE SET
  missing    = excluded.missing,
  unlocks    = excluded.unlocks,
  how_to_get = excluded.how_to_get,
  effort     = excluded.effort;

-- ── SETTINGS ────────────────────────────────────────────────────────────────
-- Retention lives in catalog-corrections.sql, NOT here, because Fede set it to
-- 'forever' on 2026-08-10 and this file used to carry the earlier 180 day
-- proposal. Re-running the seed silently reverted his decision, which the
-- "history is kept forever" check caught. A seed file must never be able to
-- overwrite a decision a person made.
