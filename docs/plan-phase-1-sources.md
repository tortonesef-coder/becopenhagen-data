# amendment_01_sources.md

Amendment to `spec_data.md`. Read that first.

Purpose: seed `catalog.gaps` with a broad catalogue of data that BeCopenhagen does not yet have in the warehouse, so the tool knows these things exist and can say "I can tell you X from what we have, but if we added Y you would get a much better answer."

Nothing here is in scope for v1. This is the roadmap, not the build.

---

## 1. Amendment to `catalog.gaps` (replaces section 3.6 of spec_data.md)

The original schema is not sufficient. For the tool to suggest a source intelligently it must know whether the data can actually be connected to anything. Monthly regional statistics cannot be joined to a booking. Daily weather can.

```sql
CREATE TABLE catalog.gaps (
  gap_key      VARCHAR PRIMARY KEY,
  category     VARCHAR,   -- internal | official | open | competitive | derived
  missing      TEXT,      -- what we don't have
  contains     TEXT,      -- what's actually in it
  unlocks      TEXT,      -- questions it would answer
  how_to_get   TEXT,
  grain        TEXT,      -- 'daily', 'per booking', 'monthly by region'
  join_key     TEXT,      -- how it connects to bc.* , or 'none: comparison only'
  effort       VARCHAR,   -- low | medium | high
  cost         VARCHAR,   -- free | subscription | staff time
  licence      TEXT,
  status       VARCHAR,   -- gap | investigating | ingested | rejected
  cited_count  INTEGER DEFAULT 0
);
```

**`join_key` is the important addition.** A source with `join_key = 'none: comparison only'` may be used for context and contradiction but never for arithmetic against `bc.*`, per section 4.4 of the spec. The agent must respect this distinction when suggesting a gap, and must not promise an answer the grain cannot support.

`status` makes this a lifecycle table rather than a wishlist. Every source in the warehouse started here.

---

## 2. Internal: exists somewhere, not yet in the warehouse

Highest value tier. This data already belongs to BeCopenhagen, so there is no acquisition problem, only a plumbing problem.

| Source | Contains | Unlocks | Grain / join | Effort |
|---|---|---|---|---|
| **Accounting** (e-conomic or equivalent, via Verum Cura) | Revenue, COGS, wages, rent, overheads, VAT | Contribution margin per product, true unit economics, break-even by month, everything the 2027 model runs on | Monthly, by account. Joins loosely on month | Medium |
| **Payroll / eIndkomst / guide hours** | Hours by person, cost per hour, contract type | Guide profitability, cost per tour, whether the 300% markup holds in practice, effect of Hassan's replacement | Per person per period. Joins to guides and tours | Medium |
| **OTA back-ends** (GYG Supplier, Viator/Tripadvisor partner, Airbnb host) | Impressions, clicks, conversion rate, ranking position, commission, cancellation reasons | **The single most valuable gap.** Distinguishes "nobody wants this" from "nobody sees this". Currently unanswerable | Daily by listing. Joins on listing and date | Medium |
| **Payment processor** (Stripe / Quickpay / Nets) | Settled amounts, refunds, chargebacks, currency, fees | Actual received revenue versus booked revenue, refund rate by product and channel | Per transaction. Joins to booking | Medium |
| **Missive** | Inbound enquiries, response times, threads, topics | Enquiry-to-booking conversion, what people ask before booking, complaint rate, whether slow replies cost bookings | Per thread. Joins on customer email | Medium |
| **Reviews** (Google, TripAdvisor, GYG, Trustpilot) | Rating, text, date, sometimes guide named | Guide quality signal, complaint themes, effect of fleet or route changes. Note the survivorship bias in `catalog.limits` | Per review. Joins on date and sometimes guide | Low |
| **Google Business Profile insights** | Search queries that surfaced the shop, direction requests, calls, photo views | Discovery for the physical location. Directly relevant to the 2028 location decision and the street-visibility doctrine | Daily. Joins on date | Low |
| **Google Search Console** | Queries, impressions, position, CTR for becopenhagen.dk | Whether direct demand exists and is being lost to OTAs, which is the whole commission argument | Daily by query. Joins on date | Low |
| **Website analytics** (GA4 / Plausible / Umami) | Sessions, source, path to the booking widget, drop-off | Funnel leakage, value of direct traffic, effect of the site issues found in the earlier audit | Per session. Joins on date | Low |
| **Maintenance log** (Zac, possibly partly in bc-fleet) | Repairs, parts, downtime per bike | True cost per bike per season, replacement timing, whether e-bikes justify their cost | Per bike per event. Joins on bike ID | Low if in bc-fleet |
| **Marketing spend** (Google Ads, Meta, if any) | Spend by channel and campaign | Cost per acquisition by channel, whether paid beats OTA commission | Daily by campaign. Joins on date | Low |
| **Rental transactions** (if not fully in FareHarbor) | Rental duration, bike type, price paid | Rental versus tour economics, effect of the 350 DKK e-bike and 750 DKK cargo price changes | Per rental. Joins on date and bike type | Unknown, confirm |
| **Bank transactions** | All movement in and out | Cross-check against accounting, cash timing | Per transaction | Medium |
| **Guide post-tour notes** | Qualitative: weather, group, incidents, route changes | Explains outliers that no numeric source can. Would need a capture habit that does not currently exist | Per departure. Joins on departure ID | High (behaviour change) |

---

## 3. External official Danish

| Source | Contains | Unlocks | Grain / join | Effort |
|---|---|---|---|---|
| **Danmarks Statistik** (in v1) | Overnight stays by region, nationality, accommodation type; capacity; employment; consumption | Market context, the December contradiction test | Monthly by region. **No join, comparison only** | Done in v1 |
| **CVR / Virk** | Registered companies, ownership, employee bands, and **published annual reports**, which are public in Denmark | Competitor revenue and profit, actual market size for Copenhagen bike tours, benchmark for the 2027 plan. Almost nobody does this and it is free | Annual by company. No join | Low |
| **VisitDenmark / Wonderful Copenhagen** | Visitor surveys, source market breakdowns, spend per visitor, sector reports | Who the visitors are rather than just how many, which segments are growing | Annual or quarterly. No join | Low, manual |
| **Copenhagen Airport traffic figures** | Monthly passengers, by region where published | A demand denominator closer to the right grain than DST, and published faster | Monthly. No join, comparison only | Low |
| **Cruise calls** (CPH Malmö Port schedule) | Ship, date, berth, passenger capacity | **Underrated.** Days with several ships in port are demand spikes. Published in advance, so it is also forecastable rather than only explanatory | Daily. **Joins on date** | Low |

---

## 4. External open data and environment

| Source | Contains | Unlocks | Grain / join | Effort |
|---|---|---|---|---|
| **DMI Frie Data** | Observations (temperature, precipitation, wind), quality-controlled climate data, forecasts. Free API, key required, JSON via OGC API Features. A Python wrapper `dmi-open-data` exists | Rain versus bookings, temperature versus cargo rental, whether a bad month was weather or business. For an outdoor seasonal business this is the highest explanatory-power free dataset available | Hourly or daily by station, Copenhagen station nearby. **Joins exactly on date** | Low |
| **Open Data DK / Københavns Kommune** | Fixed bicycle counts, traffic counts, counting stations, cycle parking counts. CSV, JSON, GeoJSON, CC-BY 4.0, continuously updated | City-wide cycling volume as a proxy for conditions and season, independent of your own demand. Also route planning and construction awareness | Daily by station. **Joins on date** | Low |
| **Public holidays** (Danish and source markets) | Dates | Calendar effects separated from real trend | Daily. **Joins on date** | Very low |
| **School holiday calendars** (DE, IT, ES, FR, UK, US) | Term dates by region | **The sleeper.** Family travel timing is driven by school calendars, and German school holidays are staggered by Bundesland. Probably explains more of your shoulder season than anything else on this list, and it is almost free to add | Daily by market. **Joins on date** | Low |
| **Daylight hours** (sunrise / sunset) | Times by date | Feasible tour windows, shoulder-season scheduling, when the 16:00 F3 departure stops working | Daily. **Joins on date** | Very low |
| **Copenhagen events calendar** | Major events, festivals, conferences | Demand spikes that look like noise otherwise | Daily. **Joins on date** | Medium, messy |

---

## 5. Competitive

| Source | Contains | Unlocks | Grain / join | Effort |
|---|---|---|---|---|
| **Competitor OTA listings** | Price, review count, review velocity, ranking position, availability shown | Real market pricing, whether you are under or over, review velocity as a volume proxy for competitors | Per listing per scrape date. No join | Medium, and you already have scraping capability |
| **Own listing rank over time** | Your position in Copenhagen category results | Whether visibility is drifting, effect of price changes on rank | Daily by listing. Joins on listing | Medium |
| **Competitor annual reports** (see CVR above) | Revenue, profit, employees | Actual competitor scale, not guesswork | Annual | Low |

Note: scrape competitor listings at a polite rate and store only public data. This is market research, not surveillance, and it should stay on the right side of that line.

---

## 6. Derived: free, no acquisition needed

These require no new source, only computation over data you already have. Build them into the `bc.*` views.

| Feature | Definition | Unlocks |
|---|---|---|
| **Lead time** | departure date minus booking date | Booking pace, pickup curves, whether a price change pulled demand forward or created it. Requires both dates kept, per the earlier decision |
| **Calendar features** | day of week, week of year, month, holiday flag | Separating calendar effect from trend |
| **Pickup curve** | share of final seats sold at T minus 7, 14, 30 | Forecasting August in June instead of learning about it in September |
| **Capacity utilisation** | pax over available seats, and bikes out over fleet size | The real occupancy measure, and whether fleet expansion was justified |
| **Repeat customer flag** | customer seen in a prior booking | Retention, which for a tourist business is probably near zero but should be measured rather than assumed |

---

## 7. Priority

If only five ever get added, these five:

1. **Accounting.** Nothing else unlocks margin, and the 2027 model cannot be rebuilt properly without it.
2. **DMI weather.** Free, joins exactly on date, and for a seasonal outdoor business it explains more variance than any other single input.
3. **OTA back-end conversion data.** The only thing that distinguishes a demand problem from a visibility problem. That ambiguity currently sits underneath most pricing and scheduling decisions.
4. **Cruise calls plus airport passengers.** Demand denominators at a grain that actually joins, and cruise schedules are published ahead, so they forecast rather than only explain.
5. **School holidays by source market.** Lowest effort on this entire list, and likely to explain a large share of shoulder-season shape.

`cited_count` will eventually disagree with this ranking. When it does, trust the counter over the reasoning, because it reflects the questions actually being asked.

---

## 8. Agent behaviour

Additions to section 5.2 of `spec_data.md`:

11. When citing a gap, state what it would unlock **for the question just asked**, not in general. "If we had guide hours by tour code I could tell you whether F3 is actually profitable" is useful. "We should add accounting data" is not.
12. Never suggest a gap whose `grain` cannot support the question. If someone asks about a specific departure, monthly regional data is not the answer, and offering it is worse than saying nothing.
13. When a gap has `join_key = 'none: comparison only'`, say so explicitly when suggesting it, so the user does not expect a joined analysis that cannot be built.
14. Still one gap per answer, maximum.

---

## 9. Open question

`catalog.gaps` should be seeded from this document during Phase 2. Fede should review the `effort` and `cost` estimates before seeding, since several of them are guesses about systems only he has seen.
