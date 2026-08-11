-- Register the copied catalog tables under their bc.* names.
--
-- sql/build-catalog-views.sql copies guide_invoices, business_facts and
-- channel_commission into the warehouse. That makes them QUERYABLE. This makes
-- them KNOWN: the agent's schema block is built from catalog.columns where
-- schema_name = 'bc', so a table the catalog files under 'catalog.' is invisible
-- to the prompt no matter what is in the warehouse.
--
-- The descriptions and gotchas already written for these tables are kept
-- verbatim. They are good, and they were written when the data was fresh in
-- someone's mind, which is the only time that quality of gotcha gets written.
--
-- Idempotent: safe to re-run.

-- ── The sources, renamed to where they now live ─────────────────────────────
INSERT OR REPLACE INTO catalog.sources
  (source_key, display_name, schema_name, layer, description, grain,
   refresh_cadence_hours, retrieval_method, retrieval_instructions, gotchas,
   last_loaded_at, last_row_count, prev_row_count, max_date_in_data, owner)
SELECT 'bc.' || split_part(source_key, '.', 2), display_name, 'bc', layer, description, grain,
       1, retrieval_method,
       'Copied into the warehouse every hour by sql/build-catalog-views.sql. The master copy is in catalog_store.duckdb; edit it there, not here.',
       gotchas, last_loaded_at, last_row_count, prev_row_count, max_date_in_data, owner
FROM catalog.sources
WHERE source_key IN ('catalog.guide_invoices', 'catalog.business_facts', 'catalog.channel_commission');

DELETE FROM catalog.sources
WHERE source_key IN ('catalog.guide_invoices', 'catalog.business_facts', 'catalog.channel_commission');

-- ── The datapoints ──────────────────────────────────────────────────────────
-- Written out by hand from the gotchas already recorded for these tables,
-- rather than by an LLM pass over the column names: there are only 28 of them,
-- and the gotchas already say the things that matter (no single guide rate, a
-- NULL total is not zero, the commission is unconfirmed).
--
-- drafted_by still says claude, because that is who wrote them. They go into
-- the Doubts queue like every other drafted description. Marking them reviewed
-- to keep the queue short would be recording a review that never happened.
DELETE FROM catalog.columns
WHERE schema_name = 'bc'
  AND table_name IN ('guide_invoices', 'business_facts', 'channel_commission');

INSERT INTO catalog.columns
  (schema_name, table_name, column_name, data_type, description, gotcha,
   sample_values, is_pii, drafted_by, reviewed_by, reviewed_at)
VALUES
-- guide_invoices
('bc','guide_invoices','invoice_id','INTEGER','Row number for the parsed invoice. Means nothing outside this table.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','guide_id','VARCHAR','The guide, resolved to the same id used everywhere else. Join to bc.guide_identity or bc.guide_hours on this.','A guide can appear more than once: two invoices, or one invoice plus a misfiled document.',NULL,TRUE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','original_name','VARCHAR','The PDF filename as uploaded.','Filenames lie. One says invoice 2 and the document inside is numbered 1.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','period_label','VARCHAR','The billing period as the guide wrote it, e.g. "July 2026".',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','period_start','DATE','First day the invoice covers, where the invoice states one.','NULL on invoices that only name a month.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','period_end','DATE','Last day the invoice covers, where the invoice states one.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','invoice_number','VARCHAR','The number the guide put on the document.','Not unique across guides. Everyone starts at 1.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','invoice_date','DATE','The date printed on the invoice, not when it was paid.','There is no payment date anywhere in this data. Never present this as when money moved.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','total_amount','DOUBLE','What the guide billed, as one number.','NULL where the document had no readable total. Monica''s is NULL because the invoice carries the template placeholder [0.00]; her subtotal is 20,575 DKK. Never treat a NULL total as zero.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','currency','VARCHAR','Currency of total_amount. DKK on everything so far.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','hours_claimed','DOUBLE','Hours the GUIDE billed for.','This is the guide''s claim, not the fleet app''s record. bc.guide_hours is what the app computed. The two disagreeing is a finding, not a bug.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','hourly_rate','DOUBLE','Rate per hour, where the invoice states one or it divides out cleanly.','THERE IS NO SINGLE GUIDE RATE. Four guides bill 250 DKK/h; Paloma bills 130 and 150 on different line types. Never assume one rate across guides.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','rate_is_derived','BOOLEAN','TRUE when the rate was computed as total divided by hours rather than read off the page.','A derived rate on an invoice with mixed line types is meaningless. Check this before quoting a rate.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','line_items','JSON','The individual lines as read from the document.','Free-form. Useful for checking a total by eye, not for aggregating across guides.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','confidence','VARCHAR','How sure the model was about its own reading: high, medium or low.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','notes','VARCHAR','What the parse flagged for a person to look at.','Read this before using a row. It is where the four known problems are recorded.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','parsed_by','VARCHAR','Which model read the PDF.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','parsed_at','TIMESTAMP','When it was read.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','reviewed_by','VARCHAR','Who checked the figures against the PDF.','NULL means nobody has. Say so when quoting the number.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','guide_invoices','reviewed_at','TIMESTAMP','When a person checked it.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
-- business_facts
('bc','business_facts','fact_key','VARCHAR','Short handle for the fact.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','business_facts','fact','VARCHAR','The fact itself, in plain English.','These are STATEMENTS, not measurements. Quote them, do not compute with them.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','business_facts','source','VARCHAR','Where it came from, normally bc-brain''s context.md.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','business_facts','verified','BOOLEAN','Whether the SOURCE document tagged it verified.','Verified in the source file, not verified here. The commission line carries no tag at all.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','business_facts','confirmed_by','VARCHAR','Who confirmed it in this tool.','NULL on everything until the Doubts queue is worked.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','business_facts','confirmed_at','TIMESTAMP','When it was confirmed here.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
-- channel_commission
('bc','channel_commission','channel','VARCHAR','The sales channel, matching the channel values on bookings.',NULL,NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL),
('bc','channel_commission','commission_rate','DECIMAL(3,2)','Believed commission as a fraction, so 0.20 means 20 percent.','UNCONFIRMED. Untagged line in context.md. Applying it gives an ESTIMATE at contracted rates, never actual commission charged. Say which one you are giving.',NULL,FALSE,'claude (by hand, from the confirmed gotchas)',NULL,NULL);
