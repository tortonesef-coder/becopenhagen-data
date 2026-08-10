-- Hand-curated catalog tables, copied into the warehouse so the agent can
-- actually query them.
--
-- These three tables hold real, hand-checked business data: guide invoice
-- figures, the business facts from the brain, and the channel commission rates.
-- They live in catalog_store.duckdb, which run_sql never opens: the agent gets a
-- read-only connection to warehouse.duckdb and nothing else. So until this file
-- existed, parsing seven invoices produced numbers no question could reach.
--
-- COPIED, NOT VIEWED, on purpose. A view over an ATTACHed database only lives as
-- long as the connection that made it, and the warehouse is rebuilt and swapped
-- hourly, so a view would evaporate. A copy is a snapshot that is at most an
-- hour behind, which is the same freshness promise as everything else here.
--
-- Read-only attach, so a bad query in the build can never damage the catalog.

ATTACH '/var/lib/bc-data/catalog_store.duckdb' AS cat (READ_ONLY);

-- Guide invoices. What each guide billed, read off their PDF by a model.
-- reviewed_by is carried across deliberately: it is how an answer can say
-- whether a figure has been checked by a person or is still a machine reading.
CREATE OR REPLACE TABLE bc.guide_invoices AS
SELECT * FROM cat.catalog.guide_invoices;

-- Business facts: things only Fede knows, stated once and reused.
CREATE OR REPLACE TABLE bc.business_facts AS
SELECT * FROM cat.catalog.business_facts;

-- What each booking channel takes. Needed for any net revenue question.
CREATE OR REPLACE TABLE bc.channel_commission AS
SELECT * FROM cat.catalog.channel_commission;

DETACH cat;
