-- What Fede actually said about three invoices, written into the data.
--
-- Two of these answers arrived through the note box BEFORE the fix that stopped
-- notes being discarded on a tick, so the information was sitting in
-- catalog.doubts.note and nowhere else. It is real business knowledge and it is
-- being recorded properly here.
--
-- A new column, document_kind, because "is this a guide invoice" turned out not
-- to be a yes-or-no question. Additive: nothing already written is changed.

ALTER TABLE catalog.guide_invoices ADD COLUMN IF NOT EXISTS document_kind VARCHAR DEFAULT 'guide_invoice';
ALTER TABLE catalog.guide_invoices ADD COLUMN IF NOT EXISTS supersession VARCHAR;

-- invoice 10, Ibrahim, 80.40 DKK.
-- Fede: "this is an expense claim, he spent 80.4DKK on renting a donkey
-- republic bike because one of our bikes broke down mid-tour."
--
-- So it is money owed to Ibrahim, but it is NOT labour, and totalling it with
-- guide hours would overstate the cost of guiding and understate the cost of
-- bikes breaking. It also records an operational event that exists nowhere else
-- in any system: a bike failed mid-tour and was replaced with a rented one.
UPDATE catalog.guide_invoices SET
  document_kind = 'expense_claim',
  notes = COALESCE(notes || E'\n\n', '') ||
    'FEDE 2026-08-10: not a guide invoice. An expense claim: Ibrahim paid 80.40 DKK to rent a Donkey Republic bike because one of ours broke down mid-tour. Reimbursable, but it is a MAINTENANCE cost, not labour. Exclude it from guide pay and hourly rates.'
WHERE invoice_id = 10;

-- invoice 11, Monica, no readable total.
-- Fede: "That's right, she ended up sending it by email. So that invoice you
-- have of monica is not the one we actually end up using to pay her."
--
-- The 20,575 DKK subtotal is from a superseded draft. The payable figure is in
-- an email nobody has put into any system, so it is genuinely unknown rather
-- than merely unparsed, and it must never be filled in from this document.
UPDATE catalog.guide_invoices SET
  document_kind = 'superseded_draft',
  supersession = 'Replaced by an invoice Monica sent by email, which is not in any system. The email version is what she was paid on.',
  notes = COALESCE(notes || E'\n\n', '') ||
    'FEDE 2026-08-10: this is not the invoice she was paid on. She sent the real one by email. Do NOT use the 20,575 DKK subtotal on this PDF as her billed amount; her actual figure is unknown to this tool.',
  reviewed_by = 'fede', reviewed_at = now()
WHERE invoice_id = 11;

-- A gap, because the money is real and the tool cannot see it.
INSERT OR REPLACE INTO catalog.gaps
  (gap_key, missing, contains, grain, join_key, unlocks, how_to_get, effort, cost, status, category, cited_count)
VALUES ('invoices_sent_by_email',
        'Guide invoices that arrive by email instead of being uploaded to the fleet app. Confirmed by Fede on 2026-08-10 for Monica, whose uploaded PDF is a superseded draft and whose real invoice went by email.',
        'Nothing yet. The documents are in a mailbox.',
        'One row per invoice.',
        'guide_id',
        'The actual amount each guide was paid, which is the difference between an estimated guide cost and a real one. Without it any per-tour margin is built on the invoices that happened to get uploaded.',
        'Forward them to the tool, or upload them on the Sources page and run scripts/extract-document.js. Either way it is minutes per invoice, and the real fix is agreeing that every invoice gets uploaded rather than emailed.',
        'small', 'free', 'gap', 'internal', 0);

-- And the operational fact, which is the part nobody would think to look for.
INSERT OR REPLACE INTO catalog.business_facts (fact_key, fact, source, verified, confirmed_by, confirmed_at)
VALUES ('bike_failure_mid_tour_2026_06',
        'A bike broke down mid-tour in June 2026 and the guide rented a Donkey Republic bike for 80.40 DKK to finish the tour. This is the only recorded instance of a mid-tour bike failure, and it was found inside an expense claim, not in any maintenance record.',
        'Fede, 2026-08-10, answering a doubt about Ibrahim''s invoice.',
        TRUE, 'fede', now());
