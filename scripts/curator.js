#!/usr/bin/env node
/**
 * The curator. Reads the catalogue and proposes what could be joined, what is
 * being ignored, and where an existing source already answers a known gap.
 *
 * Fede, 2026-08-10: "a curator that looks for opportunities for relevant
 * mergers (additive only, never replacing), or new databases."
 *
 * ADDITIVE ONLY IS ENFORCED BY SHAPE, NOT BY INTENT. Every proposal is either a
 * new view or a note. There is no proposal type that drops, replaces or edits an
 * existing source, so the worst a bad proposal can do is add something nobody
 * uses. And nothing is applied automatically: proposals sit until a person
 * accepts them, exactly like the upload classifier.
 *
 * Most of the work here is deterministic SQL over the catalogue, not model
 * judgement. Two sources sharing a join key is a fact, not an opinion, and a
 * source referenced forty times without ever being load-bearing is arithmetic.
 * Keeping it deterministic also keeps it free and keeps it honest.
 *
 *   node scripts/curator.js [--dry-run]
 *
 * Daily, not hourly: its inputs change on the timescale of weeks.
 */

const crypto = require('crypto');
const db = require('../src/db');

const DRY = process.argv.includes('--dry-run');
const q = s => (s === null || s === undefined) ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
const idFor = (kind, key) =>
  'cp_' + crypto.createHash('sha1').update(`${kind}::${key}`).digest('hex').slice(0, 16);

const proposals = [];
const add = p => proposals.push(p);

(async () => {
  const sources = await db.catalog(
    `SELECT source_key, display_name, description, grain, last_row_count FROM catalog.sources`);
  const usage = await db.catalog(`
    SELECT source_key, COUNT(*) AS uses,
           COUNT(*) FILTER (WHERE level IN ('load_bearing','decisive')) AS mattered,
           MAX(used_at) AS last_used
    FROM catalog.source_usage GROUP BY 1`).catch(() => []);
  const byUse = new Map(usage.map(u => [u.source_key, u]));

  // Two of the checks below argue "this is being neglected", and that claim is
  // only worth anything once questions have actually been asked. Usage logging
  // started on 2026-08-10; on the first run every source looked neglected,
  // because none had been used yet. A curator that flags everything teaches
  // people to ignore it, so those checks wait for evidence.
  const [{ total_uses }] = await db.catalog(
    `SELECT COUNT(*) AS total_uses FROM catalog.source_usage`).catch(() => [{ total_uses: 0 }]);
  const enoughHistory = Number(total_uses) >= 25;
  if (!enoughHistory) {
    console.log(`  note: only ${total_uses} logged use(s) so far, so the "neglected" checks would flag ` +
                `everything. Skipping them until 25.`);
  }

  // ── 0. Data that exists but the agent cannot reach ────────────────────────
  // The most valuable check here, and the one that found a real defect on its
  // first run: catalog.guide_invoices, catalog.business_facts and
  // catalog.channel_commission were registered, populated and unreachable,
  // because run_sql opens warehouse.duckdb and nothing else. Seven parsed
  // invoices that no question could touch.
  //
  // Cheap to check and impossible to argue with, so it runs first.
  const inWarehouse = new Set((await db.warehouse(
    `SELECT table_name FROM duckdb_tables() WHERE schema_name = 'bc'`)).map(r => `bc.${r.table_name}`));

  for (const s of sources) {
    const key = String(s.source_key);
    const bcName = 'bc.' + key.split('.').pop();
    if (key.startsWith('bc.') || inWarehouse.has(bcName)) continue;
    if (!key.startsWith('catalog.')) continue;

    // Only worth raising if it actually holds something.
    let rows = 0;
    try { [{ n: rows }] = await db.catalog(`SELECT COUNT(*) AS n FROM ${key}`); } catch { continue; }
    if (!Number(rows)) continue;

    add({
      kind: 'unreachable_source',
      key,
      title: `${s.display_name || key} holds ${rows} row(s) that no question can reach`,
      rationale:
        `${key} is catalogued and populated, but it lives in the catalog database and the Ask page can only ` +
        `read the warehouse. So the data exists, is described, and is invisible to every answer. ` +
        `Copying it into ${bcName} on the hourly build makes it queryable and changes nothing that already works.`,
      evidence: `${rows} rows in ${key}. Not present in the warehouse as ${bcName}.\n` +
                `What it is: ${String(s.description || '').slice(0, 220)}`,
      proposed_sql: `CREATE OR REPLACE TABLE ${bcName} AS SELECT * FROM cat.${key};  -- add to sql/build-catalog-views.sql`,
      affects: key,
      confidence: 'high',
    });
  }

  // ── 1. Sources that share a join key ──────────────────────────────────────
  // Deterministic: two tables both carrying availability_id CAN be joined. That
  // is a fact about the schema, not a guess, which is why this is SQL and not a
  // prompt.
  //
  // But the REASON to raise one is that a link is being missed, and that claim
  // rests entirely on usage history. Without it every table looks neglected and
  // this check emits "8 tables share availability_id", which is both true and
  // useless to anyone who has read the schema. So it waits for evidence.
  const cols = enoughHistory ? await db.catalog(`
    SELECT column_name, string_agg(DISTINCT table_name, ', ') AS tables, COUNT(DISTINCT table_name) AS n
    FROM catalog.columns WHERE schema_name = 'bc'
      AND column_name IN ('availability_id','booking_ref','bike_id','guide_id','member_id',
                          'customer_email','product_code')
    GROUP BY 1 HAVING COUNT(DISTINCT table_name) > 1`) : [];

  for (const c of cols) {
    const tables = c.tables.split(', ').map(t => `bc.${t}`);
    if (tables.length < 2) continue;
    // Only worth raising when at least one side is going unused. A link between
    // two heavily used tables is one people have already found.
    const neglected = tables.filter(t => !byUse.has(t) || Number(byUse.get(t).mattered || 0) === 0);
    if (!neglected.length) continue;

    add({
      kind: 'missing_link',
      key: `${c.column_name}`,
      title: `${tables.length} tables share ${c.column_name} and are not being used together`,
      rationale:
        `${tables.join(', ')} all carry ${c.column_name}, so they join directly. ` +
        `${neglected.join(', ')} ${neglected.length === 1 ? 'has' : 'have'} never carried an answer, ` +
        `which usually means nobody knows the link exists rather than that the data is useless.`,
      evidence: `Shared column: ${c.column_name}\nTables: ${tables.join(', ')}\n` +
                `Never load-bearing: ${neglected.join(', ')}`,
      proposed_sql: null,
      affects: tables.join(', '),
      confidence: neglected.length === tables.length ? 'medium' : 'high',
    });
  }

  // ── 2. Data that exists and is never used ─────────────────────────────────
  // Same gate. On the first run this flagged 15 of 18 sources: true, and useless.
  for (const s of enoughHistory ? sources : []) {
    if (!String(s.source_key).startsWith('bc.')) continue;
    const u = byUse.get(s.source_key);
    const rows = Number(s.last_row_count || 0);
    if (rows < 10) continue;                      // too small to be worth a note
    if (u && Number(u.mattered) > 0) continue;    // it has earned its place

    add({
      kind: 'unused_source',
      key: s.source_key,
      title: `${s.display_name || s.source_key} has never carried an answer`,
      rationale: u
        ? `Queried ${u.uses} time(s) but never load-bearing: it keeps getting joined without changing any answer. ` +
          `Either the questions that need it are not being asked, or it is being joined out of habit.`
        : `${rows.toLocaleString()} rows that no question has ever touched. Either nobody knows it is there, ` +
          `or the questions it answers are not the ones being asked.`,
      evidence: `${rows} rows. ${u ? `${u.uses} references, ${u.mattered} load-bearing.` : 'Never queried.'}\n` +
                `Grain: ${s.grain || 'unknown'}`,
      proposed_sql: null,
      affects: s.source_key,
      confidence: 'medium',
    });
  }

  // ── 3. A gap an existing source might already answer ──────────────────────
  // Cheap word overlap, deliberately LOW confidence. The point is to surface a
  // coincidence for a person to look at, never to close a gap automatically:
  // closing a gap wrongly is worse than leaving it open, because the tool then
  // stops offering to fill it.
  const gaps = await db.catalog(
    `SELECT gap_key, missing, contains, grain FROM catalog.gaps WHERE status IN ('gap','partial')`);
  const stop = new Set(['the','and','for','with','from','that','this','what','per','one','row','each','not','are','was','has','its','all','any','but','how','who','why','when','into','than','then','they','have','been','only','more','most','some','such','which','their','would','could','about','after','before','every','other','over','under','data','table','tables','rows','would','fleet','bike','tour','tours']);
  const words = t => new Set(String(t || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !stop.has(w)));

  for (const g of gaps) {
    const gw = words(`${g.missing} ${g.contains}`);
    if (gw.size < 5) continue;
    for (const s of sources) {
      if (!String(s.source_key).startsWith('bc.')) continue;
      const sw = words(`${s.description} ${s.grain}`);
      const shared = [...gw].filter(w => sw.has(w));
      if (shared.length < 5) continue;
      add({
        kind: 'fills_gap',
        key: `${g.gap_key}:${s.source_key}`,
        title: `${s.source_key} may already answer part of "${g.gap_key.replace(/_/g, ' ')}"`,
        rationale:
          `The gap and the source describe overlapping things (${shared.slice(0, 6).join(', ')}). ` +
          `This is word overlap rather than understanding, so it is a coincidence worth checking, not a finding. ` +
          `If it is right the gap should move to partial, not be closed.`,
        evidence: `Gap needs: ${String(g.missing).slice(0, 180)}\nSource has: ${String(s.description).slice(0, 180)}`,
        proposed_sql: null,
        affects: `${g.gap_key}, ${s.source_key}`,
        confidence: 'low',
      });
    }
  }

  // ── 4. Documents kept but never turned into data ──────────────────────────
  // This is Fede's "feels like a pity to waste this info" in mechanical form.
  const docs = await db.catalog(`
    SELECT upload_id, original_name, what_it_is FROM catalog.uploads
    WHERE file_kind = 'pdf' AND status <> 'rejected'`).catch(() => []);
  for (const d of docs) {
    add({
      kind: 'new_source',
      key: `extract:${d.upload_id}`,
      title: `"${d.original_name}" is stored as a document, so none of its numbers can be asked about`,
      rationale:
        `A PDF is kept whole because it is not a table, but the figures inside it are real data. ` +
        `extract-document.js can pull them into a proper table, the way the guide invoices were done. ` +
        `Until then the file exists and nothing in it is queryable.`,
      evidence: String(d.what_it_is || '').slice(0, 300),
      proposed_sql: `node scripts/extract-document.js --upload ${d.upload_id}`,
      affects: d.upload_id,
      confidence: 'high',
    });
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  const decided = new Set((await db.catalog(
    `SELECT proposal_id FROM catalog.curator_proposals WHERE status <> 'open'`)).map(r => r.proposal_id));
  const fresh = proposals.filter(p => !decided.has(idFor(p.kind, p.key)));

  const byKind = proposals.reduce((a, p) => (a[p.kind] = (a[p.kind] || 0) + 1, a), {});
  console.log('Curator found:');
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k.replace(/_/g, ' ')}`);
  }
  console.log(`\n${proposals.length} proposal(s), ${proposals.length - fresh.length} already decided, ${fresh.length} to queue.`);
  if (!proposals.length) { console.log('Nothing to suggest. That is a fine answer.'); return; }

  if (DRY) { console.log('\nDry run: nothing written.'); return; }
  if (!fresh.length) return;

  const values = fresh.map(p =>
    `(${q(idFor(p.kind, p.key))}, now(), ${q(p.kind)}, ${q(p.title)}, ${q(p.rationale)},` +
    ` ${q(p.evidence)}, ${q(p.proposed_sql)}, ${q(p.affects)}, ${q(p.confidence)}, 'open', NULL, NULL, NULL)`
  ).join(',\n');

  await db.catalogWrite(`
    INSERT OR REPLACE INTO catalog.curator_proposals
      (proposal_id, created_at, kind, title, rationale, evidence, proposed_sql,
       affects, confidence, status, decided_by, decided_at, note)
    VALUES ${values};`);

  const [{ open }] = await db.catalog(
    `SELECT COUNT(*) AS open FROM catalog.curator_proposals WHERE status = 'open'`);
  console.log(`\n${open} open proposal(s). Every one is additive: accepting adds something, never replaces it.`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
