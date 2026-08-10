-- The invoice gaps, corrected after the PDFs were actually parsed.
--
-- These two entries went into the agent's prompt saying the invoice numbers
-- were "unparsed" and only the filename was stored. That was true when written
-- and false by the time Fede asked his first real question, so an otherwise
-- correct answer about guide hours ended with an offer to go and get data the
-- tool already had.
--
-- A gap that has been filled and not updated is worse than a gap that was never
-- recorded: it makes the tool volunteer work that is already done.
--
-- payroll_rates stays PARTIAL, not ingested. The rates exist now, but they
-- cover 5 of 8 guides, no figure has been checked by a person, and four of the
-- seven files have known problems. Marking it closed would claim a completeness
-- that is not there.

UPDATE catalog.gaps SET
  missing = 'The RATE each guide charges, for all guides. PARSED 2026-08-10 and now queryable as bc.guide_invoices: 7 invoices, 5 of 8 active guides, with amount, hours claimed and rate where the document stated one. Still missing: the 3 guides who have not invoiced, and any figure checked by a person.',
  contains = 'bc.guide_invoices, 7 rows, one per uploaded invoice. Amount, currency, hours claimed, hourly rate, period, line items, and the parse notes. Source PDFs stay at /var/www/becopenhagen-fleet/data/invoices/<guide>/.',
  how_to_get = 'DONE for the invoices that exist: scripts/parse-invoices.js read them and bc.guide_invoices carries the figures. What is left is human, not technical. (1) Four files need eyes: Monica''s total is the template placeholder [0.00] with a 20,575 DKK subtotal, one Ibrahim file is a Donkey Republic rental receipt and not a guide invoice at all, Feidhlim''s is issued by Gleeson Translation Services, and Paloma bills two different rates. (2) Three guides have not invoiced. A payroll or eIndkomst export would still be the complete version.',
  status = 'partial'
WHERE gap_key = 'payroll_rates';

-- bike_purchase_records: the data is still missing, but getting it is now one
-- command rather than a project. Fede: "I am trying to make a system where
-- there is as little friction as possible to add data to the system."
UPDATE catalog.gaps SET
  how_to_get = 'Upload the purchase invoice on the Sources page, then run scripts/extract-document.js against it. It reads the PDF and lands a real table: supplier, purchase date, model, quantity, price per bike. Costs well under 1 DKK per document. NOTE what an invoice does NOT contain: bike numbers, lock types, frame sizes. Those are gap bike_identity_details and no invoice will ever fill them.'
WHERE gap_key = 'bike_purchase_records';

UPDATE catalog.gaps SET
  how_to_get = 'Supplier and parts invoices can now be read straight into a table: upload on the Sources page, then scripts/extract-document.js. That covers the money half. Real downtime still has to come from bc-fleet''s repair records.'
WHERE gap_key = 'maintenance_cost';
