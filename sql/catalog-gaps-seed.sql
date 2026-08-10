-- Seeds catalog.gaps from amendment_01_sources.md sections 2 to 6.
--
-- UPSERT, never DELETE + INSERT: cited_count is earned at runtime and ranks the
-- roadmap. Re-running this file refreshes the descriptions and leaves the
-- counters alone.
--
-- NOT SEEDED AS GAPS, because they are already in the warehouse (reported to
-- Fede 2026-08-10):
--   * Rental transactions      - fully present. 366 rental bookings across 14
--                                duration codes, 439,392 DKK, in bc.bookings
--                                and bc.rental_slots. The amendment's "if not
--                                fully in FareHarbor, confirm" is confirmed: it
--                                is. Seeded as status='ingested' for the record.
-- SEEDED AS status='partial', because bc-fleet holds part of them and the
-- remainder is the actual gap. Marking these plain 'gap' would make the agent
-- offer to add data it already has:
--   * Maintenance log          - repair_tickets has the repairs; parts and cost
--                                are the missing half.
--   * Payroll / guide hours    - guide_tour_hours has the HOURS; the rate and
--                                contract type are the missing half.
--   * Reviews                  - guide_reviews has platform, date and guide;
--                                THERE IS NO RATING COLUMN and no review text
--                                scraped from the platforms.
--
-- JOIN KEYS ARE CORRECTED AGAINST THE REAL SCHEMA where the amendment's claim
-- does not hold. Each correction is noted inline.

-- ── 2. Internal: exists somewhere, not yet in the warehouse ─────────────────
INSERT INTO catalog.gaps
  (gap_key, category, missing, contains, unlocks, how_to_get, grain, join_key, effort, cost, licence, status)
VALUES

('accounting', 'internal',
 'Accounting: e-conomic or equivalent, via Verum Cura.',
 'Revenue, COGS, wages, rent, overheads, VAT.',
 'Contribution margin per product, true unit economics, break-even by month, everything the 2027 model runs on.',
 'Export from e-conomic, or ask Verum Cura for a monthly trial balance.',
 'Monthly, by account.',
 'month only. bc.bookings has a departure date and a booking date, so a monthly join is possible but LOSSY: it cannot attribute a cost to a product or a departure without a cost centre per tour code, which the accounts do not carry.',
 'medium', 'staff time', 'internal', 'gap'),

('payroll_rates', 'internal',
 'What each guide is actually PAID: hourly rate and contract type. The hours themselves are already in the warehouse.',
 'Hours by person, cost per hour, contract type, from payroll or eIndkomst.',
 'Guide profitability, cost per tour, whether the 300% markup holds in practice.',
 'Payroll export, or parse the guide invoices already uploaded to bc-fleet (currently stored as PDFs with no amounts extracted).',
 'Per person per period.',
 'bc.guide_hours.guide_id, via bc.guide_identity. Sound: guide hours are already resolved to a canonical member_id, so a rate per member_id multiplies straight through.',
 'medium', 'staff time', 'internal', 'partial'),

('ota_backend_conversion', 'internal',
 'OTA back-end funnel data: GetYourGuide Supplier, Viator/Tripadvisor partner, Airbnb host.',
 'Impressions, clicks, conversion rate, ranking position, commission, cancellation reasons.',
 'THE SINGLE MOST VALUABLE GAP. Distinguishes "nobody wants this" from "nobody sees this", which is currently unanswerable and sits underneath most pricing and scheduling decisions.',
 'Log in to each supplier back-end and export. No API on some of them.',
 'Daily by listing.',
 'date + channel, NOT listing. The amendment says "joins on listing and date", but bc.* HAS NO LISTING ID: bc.bookings.channel is a coarse label (direct, GetYourGuide, Airbnb, TripAdvisor, Viator) and a channel can carry several listings. So impressions per listing cannot be attributed to a product without a listing-to-product map that does not exist yet.',
 'medium', 'staff time', 'commercial, per platform terms', 'gap'),

('payment_processor', 'internal',
 'Payment processor records: Stripe, Quickpay or Nets.',
 'Settled amounts, refunds, chargebacks, currency, fees.',
 'Actual received revenue versus booked revenue, refund rate by product and channel. Would also finally give a cancellation signal, which nothing in the fleet database has.',
 'Export from the processor dashboard.',
 'Per transaction.',
 'bc.bookings.booking_ref, IF the processor stores the FareHarbor reference. Verify before relying on it: if it does not, the join degrades to amount plus date, which is ambiguous for same-price bookings on the same day (990 DKK appears 70 times).',
 'medium', 'free', 'internal', 'gap'),

('missive_enquiries', 'internal',
 'Missive: the inbound enquiry inbox.',
 'Inbound enquiries, response times, threads, topics.',
 'Enquiry-to-booking conversion, what people ask before booking, complaint rate, whether slow replies cost bookings.',
 'Missive API or export.',
 'Per thread.',
 'lower(bc.bookings.customer_email). Sound but PARTIAL: only 517 of 710 bookings carry an email (73%), and rentals are the weakest. An enquiry-to-booking rate computed on this will understate conversion.',
 'medium', 'subscription', 'internal', 'gap'),

('reviews_full', 'internal',
 'Review CONTENT and RATINGS from the platforms. bc-fleet logs that a review happened, but not what it said or what it scored.',
 'Rating, text, date, sometimes guide named, across Google, TripAdvisor, GetYourGuide and Trustpilot.',
 'Guide quality signal, complaint themes, effect of fleet or route changes.',
 'Platform APIs where they exist (Google Business Profile), scraping where they do not.',
 'Per review.',
 'date, and sometimes guide via bc.guide_identity. NOTE bc.guide_reviews HAS NO RATING COLUMN at all, so the current 111 rows are a count of reviews logged by hand, not a satisfaction measure. See catalog.limits review_survivorship: a 50 DKK bonus per five-star review biases the sample twice.',
 'low', 'free', 'per platform terms', 'partial'),

('google_business_profile', 'internal',
 'Google Business Profile insights for the shop.',
 'Search queries that surfaced the shop, direction requests, calls, photo views.',
 'Discovery for the physical location. Directly relevant to the 2028 location decision and the street-visibility doctrine.',
 'Google Business Profile Performance API, or export from the dashboard.',
 'Daily.',
 'date.',
 'low', 'free', 'Google terms', 'gap'),

('search_console', 'internal',
 'Google Search Console for becopenhagen.dk.',
 'Queries, impressions, position, click-through rate.',
 'Whether direct demand exists and is being lost to OTAs, which is the whole commission argument.',
 'Search Console API, free.',
 'Daily by query.',
 'date. Comparison only in practice: a search impression cannot be tied to a booking without a click-through identifier the site does not currently pass.',
 'low', 'free', 'Google terms', 'gap'),

('web_analytics', 'internal',
 'Website analytics: GA4, Plausible or Umami.',
 'Sessions, source, path to the booking widget, drop-off.',
 'Funnel leakage, value of direct traffic, effect of the site issues found in the earlier audit.',
 'Whichever is installed; if none is, install Plausible or Umami.',
 'Per session.',
 'date. Session-to-booking is not joinable without passing an identifier into the FareHarbor widget.',
 'low', 'free or subscription', 'depends on tool', 'gap'),

('maintenance_cost', 'internal',
 'The COST half of maintenance: parts, supplier invoices, and real downtime. bc-fleet already records that a bike broke and when it was fixed.',
 'Repairs, parts, downtime per bike.',
 'True cost per bike per season, replacement timing, whether e-bikes justify their cost.',
 'Parts invoices from the workshop; bc-fleet would need a cost field, or a separate spreadsheet.',
 'Per bike per event.',
 'bc.repairs.bike_id -> bc.fleet_bikes.bike_id. Sound, and already wired. NOTE the existing data is thin: 10 tickets, none since 2026-07-14, which almost certainly means the feature stopped being used rather than that nothing broke.',
 'low', 'staff time', 'internal', 'partial'),

('marketing_spend', 'internal',
 'What was spent per channel per month: Google Ads, Meta, if any.',
 'Spend by channel and campaign.',
 'Cost per acquisition by channel, and whether paid beats OTA commission.',
 'Ad platform exports plus the bank.',
 'Daily by campaign.',
 'date. Campaign-to-booking attribution needs a tracking parameter carried into the booking, which does not exist, so this is spend-versus-outcome by period, not true attribution.',
 'medium', 'free', 'internal', 'gap'),

('rental_transactions', 'internal',
 'ALREADY PRESENT. Recorded here so nobody re-adds it.',
 'Rental duration, bike type, price paid.',
 'Rental versus tour economics, effect of the 350 DKK e-bike and 750 DKK cargo price changes.',
 'Nothing to do. 366 rental bookings across 14 duration codes and 439,392 DKK are already in bc.bookings; per-slot bike allocation is in bc.rental_slots.',
 'Per rental.',
 'bc.bookings.booking_ref, already joined.',
 'low', 'free', 'internal', 'ingested'),

('bank_transactions', 'internal',
 'Bank transactions.',
 'All movement in and out.',
 'Cross-check against accounting, and cash timing rather than accrual timing.',
 'Bank export, or an aggregator.',
 'Per transaction.',
 'none: comparison only. Bank lines do not carry a booking reference, so this reconciles against accounting, not against bc.*.',
 'medium', 'free', 'internal', 'gap'),

('guide_notes', 'internal',
 'Guide post-tour notes.',
 'Qualitative: weather, group, incidents, route changes.',
 'Explains outliers that no numeric source can.',
 'Needs a capture habit that does not currently exist. bc-fleet could hold it: tour_availabilities already has a row per departure to hang a note on.',
 'Per departure.',
 'bc.departures.availability_id. Sound. CAVEAT: FareHarbor reissues availability IDs when a private tour is edited, so a note written against an ID can be orphaned when the ID changes.',
 'high', 'staff time', 'internal', 'gap'),

-- ── 3. External official Danish ─────────────────────────────────────────────

('cvr_annual_reports', 'official',
 'CVR / Virk company data and published annual reports.',
 'Registered companies, ownership, employee bands, and published annual reports, which are public in Denmark.',
 'Competitor revenue and profit, actual market size for Copenhagen bike tours, a benchmark for the 2027 plan. Almost nobody does this and it is free.',
 'CVR API at cvrapi.dk, or Virk datahub. Annual reports as PDF.',
 'Annual by company.',
 'none: comparison only.',
 'low', 'free', 'public data', 'gap'),

('visitdenmark', 'official',
 'VisitDenmark and Wonderful Copenhagen reports.',
 'Visitor surveys, source market breakdowns, spend per visitor, sector reports.',
 'Who the visitors are rather than just how many, and which segments are growing.',
 'Published PDFs; manual extraction.',
 'Annual or quarterly.',
 'none: comparison only.',
 'low', 'free', 'public, attribution expected', 'gap'),

('cph_airport_traffic', 'official',
 'Copenhagen Airport monthly traffic figures.',
 'Monthly passengers, by region where published.',
 'A demand denominator closer to the right grain than Danmarks Statistik, and published faster.',
 'CPH publishes monthly traffic statistics.',
 'Monthly.',
 'none: comparison only. Monthly cannot answer a question about a departure or a week.',
 'low', 'free', 'public', 'gap'),

('cruise_calls', 'official',
 'Cruise ship calls at CPH Malmo Port.',
 'Ship, date, berth, passenger capacity.',
 'UNDERRATED. Days with several ships in port are demand spikes. Published in advance, so it forecasts rather than only explains.',
 'CPH Malmo Port publishes the call schedule.',
 'Daily.',
 'date -> bc.departures.departure_date. Sound, and one of the few external sources that joins exactly.',
 'low', 'free', 'public', 'gap'),

-- ── 4. External open data and environment ───────────────────────────────────

('weather', 'open',
 'Weather at each departure: DMI Frie Data.',
 'Observations (temperature, precipitation, wind), quality-controlled climate data, and forecasts. Free API, key required, JSON via OGC API Features. A Python wrapper dmi-open-data exists.',
 'Rain versus bookings, temperature versus cargo rental, whether a bad month was weather or business. For an outdoor seasonal business this is the highest explanatory-power free dataset available, and limit seasonality_not_trend already names weather as the main confound.',
 'Register for a DMI Frie Data API key; nearest Copenhagen station.',
 'Hourly or daily by station.',
 'date -> bc.departures.departure_date. Sound and exact. Hourly would even join to start_time.',
 'low', 'free', 'DMI open data terms', 'gap'),

('city_bike_counts', 'open',
 'Open Data DK / Kobenhavns Kommune cycling counts.',
 'Fixed bicycle counts, traffic counts, counting stations, cycle parking counts. CSV, JSON, GeoJSON, continuously updated.',
 'City-wide cycling volume as a proxy for conditions and season, independent of our own demand. Also route planning and construction awareness.',
 'opendata.dk, no key required.',
 'Daily by station.',
 'date. Sound.',
 'low', 'free', 'CC-BY 4.0, attribution required', 'gap'),

('public_holidays', 'open',
 'Public holiday calendars, Danish and source markets.',
 'Dates.',
 'Calendar effects separated from real trend. THIS IS THE BLOCKER on the holiday_flag calendar feature, which is otherwise free.',
 'Any holiday API, or a static table. Denmark alone is a dozen dates a year.',
 'Daily.',
 'date -> bc.departures.departure_date. Sound and exact.',
 'low', 'free', 'public', 'gap'),

('school_holidays', 'open',
 'School holiday calendars for the source markets: DE, IT, ES, FR, UK, US.',
 'Term dates by region.',
 'THE SLEEPER. Family travel timing is driven by school calendars, and German school holidays are staggered by Bundesland. Probably explains more of the shoulder season than anything else on this list, and is almost free to add.',
 'Published per country, and per Bundesland for Germany. Static tables, updated yearly.',
 'Daily by market.',
 'date, and market via bc.bookings.channel or customer country. CAVEAT: bc.* HAS NO CUSTOMER COUNTRY. The fleet bookings table carries a phone number but no country field, so market cannot currently be derived except crudely from the phone prefix. Without that, this joins on date only and loses the per-market precision that makes it valuable.',
 'low', 'free', 'public', 'gap'),

('daylight_hours', 'open',
 'Sunrise and sunset times.',
 'Times by date.',
 'Feasible tour windows, shoulder-season scheduling, and when the 16:00 F3 departure stops working.',
 'Computable from latitude and longitude with no API at all.',
 'Daily.',
 'date -> bc.departures.departure_date, and comparable against start_time. Sound.',
 'low', 'free', 'n/a, computed', 'gap'),

('events_calendar', 'open',
 'Copenhagen events calendar.',
 'Major events, festivals, conferences.',
 'Demand spikes that look like noise otherwise.',
 'No single clean source; would need assembling from several.',
 'Daily.',
 'date. Sound but the source is messy.',
 'medium', 'free', 'varies', 'gap'),

-- ── 5. Competitive ──────────────────────────────────────────────────────────

('competitor_listings', 'competitive',
 'Competitor OTA listings.',
 'Price, review count, review velocity, ranking position, availability shown.',
 'Real market pricing, whether we are under or over, and review velocity as a volume proxy for competitors.',
 'Scrape at a polite rate, store only public data. Market research, not surveillance. bc-fleet already has Playwright scraping capability.',
 'Per listing per scrape date.',
 'none: comparison only.',
 'medium', 'staff time', 'public data, respect platform terms', 'gap'),

('own_listing_rank', 'competitive',
 'Our own position in Copenhagen category results over time.',
 'Rank by listing by day.',
 'Whether visibility is drifting, and the effect of price changes on rank.',
 'Same scrape as competitor_listings.',
 'Daily by listing.',
 'date. Not listing: bc.* has no listing identifier, only a coarse channel label. Same limitation as ota_backend_conversion.',
 'medium', 'staff time', 'public data', 'gap'),

-- ── 6. Derived (the ones NOT built, with the reason) ────────────────────────

('holiday_flag', 'derived',
 'A holiday flag on every date.',
 'Whether a given date is a public or school holiday, in Denmark or a source market.',
 'The calendar half of separating seasonality from trend. Day of week, week and month are already built; the holiday flag is the piece that needs an outside list.',
 'Blocked only by public_holidays and school_holidays above. Nothing else is missing.',
 'Daily.',
 'date -> bc.departures.departure_date.',
 'low', 'free', 'public', 'gap'),

('pickup_curve', 'derived',
 'Share of final seats sold at T minus 7, 14 and 30 days.',
 'Booking pace normalised against the final figure per departure.',
 'Forecasting August in June instead of learning about it in September.',
 'COMPUTABLE IN PRINCIPLE from bc.booking_pace, which already has every pax movement with days_before_departure. BLOCKED IN PRACTICE by history: pax is only trustworthy from 2026-08-03, so a curve built today rests on about a week of completed departures. Revisit once there are two months of reliable pax, or once the FareHarbor history lands in phase 5.',
 'Per departure per day before departure.',
 'bc.booking_pace.availability_id. Already joined.',
 'low', 'free', 'internal', 'gap')

ON CONFLICT (gap_key) DO UPDATE SET
  category   = excluded.category,
  missing    = excluded.missing,
  contains   = excluded.contains,
  unlocks    = excluded.unlocks,
  how_to_get = excluded.how_to_get,
  grain      = excluded.grain,
  join_key   = excluded.join_key,
  effort     = excluded.effort,
  cost       = excluded.cost,
  licence    = excluded.licence,
  status     = excluded.status;
  -- cited_count deliberately NOT updated: it is earned at runtime.

-- ── Bring the phase 2 gaps up to the v2 schema ──────────────────────────────
-- These predate the amendment and kept their earned cited_count through the
-- migration. history_pre_2026 in particular has been cited 9 times.

UPDATE catalog.gaps SET
  category = 'internal', contains = 'Bookings, sales and customer line items back to December 2022, as three FareHarbor CSV exports.',
  grain = 'Per booking, per payment, per line item.',
  join_key = 'bc.bookings.booking_ref. Sound: the exports carry the same FareHarbor booking reference the fleet app stores.',
  cost = 'staff time', licence = 'internal', status = 'gap'
WHERE gap_key = 'history_pre_2026';

UPDATE catalog.gaps SET
  category = 'internal', contains = 'The departure rows for July 2026 that were deleted from the live fleet database.',
  grain = 'Per departure.',
  join_key = 'bc.departures.availability_id. Partly recovered already in bc.departures_recovered, which over-counts by about 43%.',
  cost = 'staff time', licence = 'internal', status = 'partial'
WHERE gap_key = 'july_departures';

UPDATE catalog.gaps SET
  category = 'internal', contains = 'The commission actually charged per booking, rather than the assumed rate.',
  grain = 'Per booking.',
  join_key = 'bc.bookings.booking_ref, via the FareHarbor sales report.',
  cost = 'staff time', licence = 'internal', status = 'gap'
WHERE gap_key = 'ota_commission_actual';

UPDATE catalog.gaps SET
  category = 'internal', contains = 'Which bookings were cancelled, and when.',
  grain = 'Per booking.',
  join_key = 'bc.bookings.booking_ref. The FareHarbor bookings report has a Cancelled? column; nothing in the fleet database records it at all.',
  cost = 'staff time', licence = 'internal', status = 'gap'
WHERE gap_key = 'cancellations';

UPDATE catalog.gaps SET
  category = 'internal', contains = 'Which bike type each customer actually took on a rental.',
  grain = 'Per booking line item.',
  join_key = 'bc.bookings.booking_ref, via the FareHarbor customers report.',
  cost = 'staff time', licence = 'internal', status = 'gap'
WHERE gap_key = 'bike_type_per_booking';

UPDATE catalog.gaps SET
  category = 'internal', contains = 'When each bike was bought and when it was retired.',
  grain = 'Per bike.',
  join_key = 'bc.fleet_bikes.bike_id. Nothing digital exists; bikes.created_at is when the row was typed in during the 2026-06-28 setup, not a purchase date.',
  cost = 'staff time', licence = 'internal', status = 'gap'
WHERE gap_key = 'fleet_history';

-- Superseded by payroll_rates, which says the same thing against the real
-- schema (the hours are already present; only the rate is missing).
UPDATE catalog.gaps SET status = 'rejected',
  missing = 'SUPERSEDED by payroll_rates. Kept so its citation count is not lost.',
  category = 'internal', contains = 'See payroll_rates.', grain = 'n/a',
  join_key = 'see payroll_rates', cost = 'staff time', licence = 'internal'
WHERE gap_key = 'guide_cost_per_tour';
