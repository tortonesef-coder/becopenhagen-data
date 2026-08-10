-- Things Fede has said that exist in no database anywhere.
--
-- Seeded from the phase 0 to 2 conversations of 2026-08-10. Every row here is
-- knowledge that FareHarbor does not hold, the fleet app does not hold, and
-- that would have been lost when the chat window closed.
--
-- From phase 3 onward the Ask page writes to this table directly whenever Fede
-- or Søren replies to an answer, and the loop is: captured -> applied into
-- gotchas / definitions / limits -> the agent stops repeating the mistake.
--
-- Idempotent on correction text so re-running never duplicates.

DELETE FROM catalog.corrections WHERE said_by = 'fede' AND said_at = TIMESTAMP '2026-08-10 00:00:00';

INSERT INTO catalog.corrections
  (id, said_at, said_by, correction, context, applies_to, status, applied_where, applied_at)
VALUES

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 '12 people fit on each tour, except F3 that fits only 10. Private sells with max 16, but if they email us we can put more, and custom no limit.',
 'Asked for per-product capacity, which exists in no database. FareHarbor was later found to agree exactly on the group tours and A3P.',
 'bc.products', 'applied',
 'bc.products.stated_capacity, plus the pax_within_capacity assertion set to warn rather than block', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'The ones that never run might still run. These numbers might change in the future.',
 'Asked whether A3F (French) and H3P (private history) were retired, since neither has run in the six weeks of data.',
 'bc.products', 'applied',
 'catalog.sources gotcha on bc.products: exclude never-run products by checking departure count, not by assuming they are dead', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'The tool should probably have a settings section where I can update this sort of data? Or we can find a way to auto update it?',
 'Follow-up to giving the capacities by hand. Prompted checking whether FareHarbor already published capacity, which it does, per departure, and the scraper was discarding it.',
 'bc.departure_capacity', 'applied',
 'Capacity harvested per departure from FareHarbor payloads instead of a settings page. Recorded as a general rule: check whether FareHarbor already knows a number before building a screen to type it in.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'Retire the old tool, I never use it. Don''t worry we have the data living somewhere else, I want the cleanest build.',
 'Decision on whether to absorb bc-brain and its analytics.db (booking history back to Dec 2022) into bc-data.',
 'bc-brain', 'applied',
 'CLAUDE_CONTEXT section 5. analytics.db is not ported; the history returns via the FareHarbor exports in phase 5.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'I can''t afford breaking the fleet app for now, so don''t touch it, but I also don''t want to lose data starting around 26th october, I want to save all data. We can debloat and clean later on if needed.',
 'Decision on the fleet app''s 120 day log retention and the known phantom-logging bug.',
 'bc.booking_pace', 'applied',
 'The permanent Parquet archive. The fleet app was not modified. Compression made "save everything" cost under 100 MB a year.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'Allow them when asked for.',
 'Decision on whether customer names, emails and phone numbers may be returned in answers and therefore sent to the Anthropic API.',
 'policy:pii', 'applied',
 'is_pii is a label rather than a block on catalog.columns. Behaviour rule 8 (aggregate by default) still stands.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'What we''re doing now should be done using my monthly pro max 20x account tokens, not my API key. Then the queries Soren and I do on a daily basis, that should use the API key.',
 'The column-description bootstrap had called the Anthropic API directly and drained the balance to zero, blocking the build.',
 'policy:cost', 'applied',
 'bootstrap-columns.js now refuses to call the API without an explicit --api flag; the default path is --dump then --import, drafted in a Claude Code session.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'My question history should stay forever, and also the info I provide in the chat, in response to a response, should be kept as valuable info, maybe it''s an important correction about assumptions.',
 'Asked to confirm a 180 day retention period on the query log.',
 'catalog.query_log', 'applied',
 'Retention set to forever, and this table (catalog.corrections) created because of the second half of the sentence.', now()),

(nextval('catalog.corrections_id'), TIMESTAMP '2026-08-10 00:00:00', 'fede',
 'Yes I''d like to have a backup of the whole VPS ideally.',
 'Asked whether a full-server backup was too large, and whether a second VPS was needed.',
 'policy:backup', 'new',
 NULL, NULL);

-- Query log retention: forever, per the correction above.
DELETE FROM catalog.settings WHERE key IN ('query_log_retention_days', 'corrections_retention_days');
INSERT INTO catalog.settings (key, value, updated_at, updated_by) VALUES
('query_log_retention_days', 'forever', now(), 'fede (2026-08-10)'),
('corrections_retention_days', 'forever', now(), 'fede (2026-08-10)');
