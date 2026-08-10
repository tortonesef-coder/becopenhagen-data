#!/usr/bin/env node
/**
 * Doubts that come out of a JOB, not out of the catalog.
 *
 * This script used to enumerate the catalog: every unreviewed column, every
 * unverified canonical query, every measured assertion bound, every gap
 * estimate. That produced 244 cards, and Fede said the only sane thing about
 * it: "I am running into a lot of time consuming dumb issues... Did we build
 * this wrong?"
 *
 * Yes, this part. He asked for "atomic nuggets of doubts which I can confirm or
 * deny". I turned that into a completeness exercise over the whole catalog and
 * handed him the tool's own bookkeeping as homework. 174 of those 244 cards
 * could not have been answered by anyone who had not read the schema.
 *
 * TWO KINDS OF DOUBT ARE LEGITIMATE, and neither is an enumeration:
 *
 *   1. a JOB produced an uncertain result. A model read seven invoice PDFs and
 *      flagged four of them. That uncertainty is real, it is about money, and
 *      it exists whether or not anyone asks a question. That is this file.
 *   2. an ANSWER rested on an assumption only Fede can settle. Raised in the
 *      moment by the flag_doubt tool, attached to the question that forced it.
 *      See src/tools.js.
 *
 * If you are tempted to add a section here that loops over a catalog table,
 * do not. That is the mistake this file was rewritten to remove.
 *
 *   node scripts/generate-doubts.js [--dry-run]
 */

const crypto = require('crypto');
const db = require('../src/db');

const DRY = process.argv.includes('--dry-run');
const q = s => (s === null || s === undefined) ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;

// Stable id from the kind and subject, so re-running updates rather than
// duplicating, and a decision survives regeneration.
const idFor = (kind, subject) =>
  'db_' + crypto.createHash('sha1').update(`${kind}::${subject}`).digest('hex').slice(0, 16);

const doubts = [];
const add = d => doubts.push(d);

/** Query results as a plain aligned table, so a card can show an answer rather than SQL. */
function asTable(rows) {
  const cols = Object.keys(rows[0]);
  const fmt = v => v === null || v === undefined ? '-'
    : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toFixed(2))
    : String(v).slice(0, 40);
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => fmt(r[c]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [line(cols.map(c => c.replace(/_/g, ' '))), line(w.map(n => '-'.repeat(n))),
    ...rows.map(r => line(cols.map(c => fmt(r[c]))))].join('\n');
}

(async () => {
  // ── 1. Invoice figures. Highest priority: these are money, a person is
  // owed them, and the model flagged specific problems with four of seven.
  for (const r of await db.catalog(`
      SELECT invoice_id, guide_id, original_name, total_amount, currency, hours_claimed,
             hourly_rate, confidence, notes
      FROM catalog.guide_invoices WHERE reviewed_by IS NULL`).catch(() => [])) {
    const amount = r.total_amount == null ? 'NO TOTAL FOUND' : `${r.total_amount} ${r.currency || ''}`;
    add({
      kind: 'invoice_figure',
      subject: `invoice:${r.invoice_id}`,
      question: r.total_amount == null
        ? `${r.guide_id}'s invoice has no readable total. Is that right?`
        : `Did ${r.guide_id} invoice ${amount}${r.hours_claimed != null ? ` for ${r.hours_claimed} hours` : ''}?`,
      detail: `File: ${r.original_name}\nRead as: ${amount}` +
              `${r.hours_claimed != null ? `, ${r.hours_claimed} hours` : ', no hours stated'}` +
              `${r.hourly_rate != null ? `, ${r.hourly_rate}/hour` : ', no rate stated'}` +
              `\nThe model rated its own reading "${r.confidence}".` +
              (r.notes ? `\n\nWhat it flagged:\n${r.notes}` : ''),
      proposed: amount,
      impact: 'Guide cost per tour, and whether a product actually makes money. A wrong figure here makes every margin number wrong.',
      priority: r.confidence === 'high' && r.total_amount != null ? 2 : 1,
      writeback_sql: `UPDATE catalog.guide_invoices SET reviewed_by = {user}, reviewed_at = now() WHERE invoice_id = ${r.invoice_id}`,
    });
  }

  // ── 6. Upload caveats: what the classifier warned about a file that was kept.
  for (const r of await db.catalog(`
      SELECT upload_id, proposed_name, caveats, fills_gap FROM catalog.uploads
      WHERE status = 'ingested' AND COALESCE(caveats,'') <> ''`).catch(() => [])) {
    add({
      kind: 'upload_caveat',
      subject: r.upload_id,
      question: `Is this warning about "${r.proposed_name}" correct?`,
      detail: r.caveats,
      proposed: r.caveats,
      impact: 'These warnings are attached to the source and repeated in every answer that uses it. A wrong one is noise; a missing one is a wrong answer.',
      priority: 3,
      writeback_sql: null,
    });
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  //
  // SKIP MEANS LATER, NOT NEVER. It did mean never: a skipped doubt stopped
  // being served (the queue only shows 'open') and was never regenerated (it
  // counted as decided), so pressing Skip silently deleted the question. Fede
  // pressed it on three, including one he had no way to answer as written,
  // which is exactly the case where the question should come back once it has
  // been rewritten.
  //
  // A week is long enough not to nag and short enough that nothing is lost.
  const [{ reopened }] = await db.catalogWrite(`
    UPDATE catalog.doubts SET status = 'open', decided_by = NULL, decided_at = NULL
    WHERE status = 'skipped' AND (decided_at IS NULL OR decided_at < now() - INTERVAL 7 DAY)
    RETURNING 1 AS reopened;`).then(r => [{ reopened: r.length }]).catch(() => [{ reopened: 0 }]);
  if (reopened) console.log(`  ${reopened} skipped doubt(s) put back in the queue. Skip means later, not never.`);

  // A question comes back the moment the THING IT ASKS ABOUT changes, without
  // waiting out the week. Two cases, and both happened on day one:
  //
  //   skipped, then reworded. Fede skipped "Is this limit set sensibly: history
  //   horizon?" because it was unanswerable. Once the wording changes it is a
  //   different question and holding back the readable version helps nobody.
  //
  //   denied, then FIXED. He denied the bike type query with "we don't own 255
  //   guided bikes, what does bikes allocated mean exactly?" That was acted on
  //   and the query rewritten. A denial is an answer to the OLD version; the new
  //   one has never been seen, and without this it never would be, because
  //   denied counts as decided forever.
  //
  // The comparison is on `proposed`, the artefact itself, not on the question
  // text: for a canonical query the wording is fixed and the SQL is the thing
  // that changes.
  const decided = await db.catalog(
    `SELECT doubt_id, question, proposed, status FROM catalog.doubts
     WHERE status IN ('skipped','denied')`).catch(() => []);
  const nowAsking = new Map(doubts.map(d => [idFor(d.kind, d.subject), d]));
  const changed = decided.filter(s => {
    const fresh = nowAsking.get(s.doubt_id);
    if (!fresh) return false;
    return String(fresh.proposed ?? '') !== String(s.proposed ?? '')
        || (s.status === 'skipped' && fresh.question !== s.question);
  });
  if (changed.length) {
    await db.catalogWrite(`
      UPDATE catalog.doubts SET status = 'open', decided_by = NULL, decided_at = NULL
      WHERE doubt_id IN (${changed.map(r => q(r.doubt_id)).join(',')});`);
    console.log(`  ${changed.length} doubt(s) changed since they were decided, so back in the queue.`);
  }

  const existing = new Set((await db.catalog(
    `SELECT doubt_id FROM catalog.doubts WHERE status <> 'open'`)).map(r => r.doubt_id));

  // THE QUEUE MUST SHRINK, NOT GROW. Fede: "me checking or X doubts should make
  // the model smarter also, so it has fewer doubts in the future."
  //
  // Two ways that happens here. First, anything already decided is never
  // re-asked (the set above). Second, a KIND that is being confirmed almost
  // every time is a kind the models are reliably right about, so asking more of
  // them wastes the one scarce resource in this system, which is Fede's
  // attention. Once a kind is 15-for-15 or better at 90%, only a sample of the
  // rest is queued.
  const track = await db.catalog(`
    SELECT kind,
           COUNT(*) FILTER (WHERE status = 'confirmed') AS yes,
           COUNT(*) FILTER (WHERE status = 'denied')    AS no
    FROM catalog.doubts WHERE status IN ('confirmed','denied') GROUP BY 1`);
  const trusted = new Map();
  for (const t of track) {
    const total = Number(t.yes) + Number(t.no);
    if (total >= 15 && Number(t.yes) / total >= 0.9) trusted.set(t.kind, Number(t.yes) / total);
  }
  for (const [kind, rate] of trusted) {
    console.log(`  note: ${kind.replace(/_/g, ' ')} confirmed ${Math.round(rate * 100)}% of the time, so only a sample of the rest is queued`);
  }

  let fresh = doubts.filter(d => !existing.has(idFor(d.kind, d.subject)));
  if (trusted.size) {
    let i = 0;
    fresh = fresh.filter(d => !trusted.has(d.kind) || (i++ % 5 === 0));
  }
  const byKind = doubts.reduce((a, d) => (a[d.kind] = (a[d.kind] || 0) + 1, a), {});

  console.log('Doubts found:');
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k.replace(/_/g, ' ')}`);
  }
  console.log(`\n${doubts.length} total, ${doubts.length - fresh.length} already decided, ${fresh.length} to queue.`);

  if (DRY) { console.log('\nDry run: nothing written.'); return; }
  if (!fresh.length) { console.log('Nothing new.'); return; }

  const values = fresh.map(d =>
    `(${q(idFor(d.kind, d.subject))}, now(), ${q(d.kind)}, ${q(d.subject)}, ${q(d.question)},` +
    ` ${q(d.detail)}, ${q(d.proposed)}, ${q(d.impact)}, ${d.priority}, ${q(d.writeback_sql)}, 'open', NULL, NULL, NULL)`
  ).join(',\n');

  await db.catalogWrite(`
    INSERT OR REPLACE INTO catalog.doubts
      (doubt_id, created_at, kind, subject, question, detail, proposed, impact,
       priority, writeback_sql, status, decided_by, decided_at, note)
    VALUES ${values};`);

  const [{ open }] = await db.catalog(
    `SELECT COUNT(*) AS open FROM catalog.doubts WHERE status = 'open'`);
  console.log(`\nQueued. ${open} open doubt(s), highest priority first.`);
  console.log('The top of the queue is money and the queries the tool trusts verbatim.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
