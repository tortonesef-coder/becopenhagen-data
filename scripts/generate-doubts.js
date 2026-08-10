#!/usr/bin/env node
/**
 * Scans the catalog for everything a model is unsure about and turns each one
 * into a single answerable question.
 *
 * Idempotent: a doubt already decided is never regenerated, and an open one is
 * refreshed rather than duplicated. Safe to run on a schedule.
 *
 * The ranking matters more than the count. Nobody works through 160 questions,
 * so priority 1 is reserved for things that would change a number Fede acts on,
 * and the queue is served in that order. A question that cannot change an
 * answer does not belong at the top, however uncertain the model is about it.
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

  // ── 2. Canonical queries. The agent is told to trust these VERBATIM, so an
  // unverified one is trusted without ever having been checked.
  //
  // SHOW THE ANSWER, NOT THE QUERY. The card used to print the SQL and ask "is
  // this the right way to answer it?", which is unanswerable unless you read
  // SQL. Fede: "still too confusing imo." He is right, and he is also the only
  // person who can do the check that matters: he knows his own business, so if
  // the top bike type is one he barely owns, he will spot it in a second where
  // no amount of SQL review would.
  //
  // So the query is RUN here and its real output goes on the card. Verify by
  // result, not by code.
  for (const r of await db.catalog(`
      SELECT query_key, question_pattern, sql, notes
      FROM catalog.canonical_queries WHERE verified_by IS NULL`)) {
    const asked = String(r.question_pattern).split(';')[0].trim();

    let shown;
    if (String(r.sql).includes('{')) {
      // Needs a date or a product filled in, so there is no single answer to
      // show. Ask about the WORDING instead, which is still answerable.
      shown = 'This one needs a date or a tour name filled in, so there is no single answer to show.';
    } else {
      try {
        const rows = await db.warehouse(`SELECT * FROM (${String(r.sql).replace(/;\s*$/, '')}) LIMIT 8`);
        shown = rows.length ? asTable(rows) : 'It comes back with no rows at all. That may be right, or it may be the bug.';
      } catch (e) {
        shown = `It does not run: ${e.message}\n\nThat is a bug regardless of your answer, and I will fix it.`;
      }
    }

    add({
      kind: 'canonical_query',
      subject: r.query_key,
      question: `If you asked "${asked}", is this the answer you would expect?`,
      detail: `${shown}\n\n${r.notes}`,
      proposed: r.sql,
      impact: 'This is the tool\'s standard answer to that question, reused every time anyone asks it. If it is wrong, it is wrong the same way forever.',
      priority: 2,
      writeback_sql: `UPDATE catalog.canonical_queries SET verified_by = {user}, verified_at = now() WHERE query_key = ${q(r.query_key)}`,
    });
  }

  // ── 3. Assertion bounds, but ONLY the ones a person can actually answer.
  //
  // This section used to queue every measured bound as "Is this limit set
  // sensibly: history horizon?" with the raw engineering note underneath. Fede
  // hit it and said, reasonably, "I don't know how to handle it." He was right
  // to skip it. Nothing in that card was answerable by someone who has not read
  // the schema, and asking anyway does two bad things: it wastes the only scarce
  // resource here, his attention, and it invites a rubber stamp on something
  // nobody actually checked.
  //
  // A bound measured off the data is MY call, and it stays measured. A bound
  // that turns on how the business really works is HIS call, and there are six
  // of those. Each is phrased as the business question underneath it, with the
  // consequence of getting it wrong stated in the same terms.
  const ASK_FEDE = {
    revenue_per_booking_plausible: {
      question: 'Could one single booking ever be worth more than 25,000 DKK?',
      detail: 'The biggest booking in the data so far is 19,300 DKK for a tour and 10,800 for a rental.\n\nRight now anything above 25,000 gets flagged as "check this, it might be a mistake" before the tool quotes it.',
      impact: 'Set too low and the tool second-guesses your genuinely big group bookings. Set too high and a parsing error worth ten times the real amount goes straight into a revenue total.',
    },
    monthly_pax_plausible: {
      question: 'Could you ever carry more than 2,000 passengers in a single month?',
      detail: 'The busiest month on record here is August 2026, with 294 passengers.\n\n2,000 is roughly seven times that. Anything above it is treated as a counting error rather than a record month.',
      impact: 'If a query accidentally counts the same booking many times over, this is what catches it. If 2,000 is genuinely reachable in a peak summer, the check needs to move up.',
    },
    bikes_within_fleet: {
      question: 'Can more bikes go out in one day than you actually own?',
      detail: 'You have 104 active bikes. The busiest day in the data is 65 bikes out, on 2 October, from one large custom booking.\n\nThe tool currently warns whenever a day needs more bikes than the fleet holds.',
      impact: 'If you ever borrow or hire in bikes for a big group, that is a real day, not an error, and the tool should not flag it. If you never do, then a day over 104 always means something is double-counted.',
    },
    fill_rate_is_a_proportion: {
      question: 'Can a tour ever end up MORE than full?',
      detail: 'You said private tours sell at max 16 but you will take more if people email and ask.\n\nSo the tool allows a tour to show up to 150% full before it treats the number as broken.',
      impact: 'If you regularly squeeze in well beyond the stated maximum, the tool will wrongly call those real departures a bug. If you never go above the limit, anything over 100% is a capacity number gone wrong.',
    },
    zero_value_bookings: {
      question: 'Six bookings are worth exactly 0 DKK. Are those free rides you gave away, or a mistake?',
      detail: 'Four came through direct, two through Airbnb.\n\nIf they are genuine freebies the tool should name them when it reports an average, because six zeroes drag any average down.',
      impact: 'Called wrong, either your revenue per booking reads low for no visible reason, or six real errors sit in the data unnoticed.',
    },
    small_n_fill_rate: {
      question: 'When a tour has only run a handful of times, would you rather see a percentage or the raw numbers?',
      detail: 'Right now anything computed from fewer than fifteen departures gets reported as raw counts ("4 of 6 seats sold, across 3 departures") instead of a percentage, because a percentage off three departures looks far more solid than it is.\n\nAs of today only A3 has run enough times to clear that bar, so this affects nearly every per-tour question.',
      impact: 'Percentages off tiny numbers are how people talk themselves into decisions. But if you find the raw counts harder to read, the threshold can come down.',
    },
  };

  for (const r of await db.catalog(`
      SELECT assertion_key, message, severity, bounds_source FROM catalog.assertions
      WHERE bounds_source = 'measured'`)) {
    const ask = ASK_FEDE[r.assertion_key];
    if (!ask) continue;   // measured from the data: my call, and it stays measured
    add({
      kind: 'assertion_bound',
      subject: r.assertion_key,
      question: ask.question,
      detail: ask.detail,
      proposed: r.message,
      impact: ask.impact,
      priority: 3,
      writeback_sql: `UPDATE catalog.assertions SET bounds_source = 'stated_by_fede' WHERE assertion_key = ${q(r.assertion_key)}`,
    });
  }

  // ── 4. Gap effort and cost. Amendment section 9 says these are guesses about
  // systems only Fede has seen.
  for (const r of await db.catalog(`
      SELECT gap_key, missing, effort, cost, status FROM catalog.gaps
      WHERE status IN ('gap','partial') AND effort IS NOT NULL`)) {
    add({
      kind: 'gap_estimate',
      subject: r.gap_key,
      question: `Would getting "${r.gap_key.replace(/_/g, ' ')}" really be ${r.effort} effort?`,
      detail: `${r.missing}\n\nCurrently estimated: ${r.effort} effort, ${r.cost || 'unknown'} cost.\nThese are guesses about systems only you have seen.`,
      proposed: `${r.effort} effort, ${r.cost}`,
      impact: 'The Gaps page is the data roadmap. A wrong effort estimate sends the next month of work at the wrong thing.',
      priority: 5,
      writeback_sql: null,   // no flag to set; the answer arrives as a note
    });
  }

  // ── 5. Column descriptions, but only where the model ADMITTED it was unsure.
  //
  // This used to queue all 162 unreviewed columns as "Is this right about
  // bc.booking_pace.departure_date?". Almost none of them needed a person: a
  // description like "the date of the departure" is checkable against the data,
  // which is my job, not Fede's. Asking him anyway buried the seven that
  // genuinely need him under 155 that did not, and the queue nobody finishes
  // protects nothing.
  //
  // The signal is HEDGING. When the drafting model wrote "probably", "appears
  // to", "assumed", "unclear", it was flagging a guess it could not resolve
  // from the data. That is precisely the case where the answer lives in Fede's
  // head and nowhere else. Everything else stays unreviewed and honestly
  // labelled as drafted-not-reviewed, which is what the catalog already says.
  const HEDGE = /\b(probabl|appears to|seems? to|seem |assum|believ|unclear|unknown|not clear|presumabl|likely|may be|might be|unverified|guess)/i;

  for (const r of await db.catalog(`
      SELECT table_name, column_name, description, gotcha, is_pii
      FROM catalog.columns WHERE reviewed_by IS NULL AND description IS NOT NULL`)) {
    const key = `${r.table_name}.${r.column_name}`;
    const text = `${r.description || ''} ${r.gotcha || ''}`;
    if (!HEDGE.test(text)) continue;

    // Quote the hedge back, so the card asks about the uncertain bit rather
    // than about the whole paragraph.
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => HEDGE.test(s));
    add({
      kind: 'column_description',
      subject: key,
      question: `The tool is guessing about "${r.column_name.replace(/_/g, ' ')}". Do you know the answer?`,
      detail: `It is unsure about this:\n\n${sentences.join('\n\n')}\n\nFull note on bc.${key}:\n${r.description}` +
              `${r.gotcha ? `\n\nAnd: ${r.gotcha}` : ''}`,
      proposed: sentences.join(' '),
      impact: 'It wrote this down as a guess and then uses it in every answer that touches this column. A guess nobody corrects becomes a fact nobody questions.',
      priority: 5,
      writeback_sql: `UPDATE catalog.columns SET reviewed_by = {user}, reviewed_at = now() WHERE schema_name='bc' AND table_name = ${q(r.table_name)} AND column_name = ${q(r.column_name)}`,
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
