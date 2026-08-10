// Builds the static context block that prefixes every call.
//
// PROMPT CACHING IS ARCHITECTURAL, NOT AN OPTIMISATION (spec section 5). This
// block is byte-identical across calls and is sent as a cached prefix, which is
// the difference between a sustainable and an unsustainable running cost. So:
//
//   * it is built ONCE at boot and reused, never rebuilt per request;
//   * nothing volatile goes in it. No timestamps, no row counts, no "data as
//     of". Those change hourly and would break the cache on every refresh, so
//     they are fetched per request instead and passed as ordinary content.
//
// It is rebuilt when the catalog changes, via reload(), because definitions and
// gotchas are edited by hand and a stale cached prompt would keep the agent
// working from a definition Fede has already corrected.

const db = require('./db');

let cached = null;

const BUSINESS = `
# BeCopenhagen

Guided bike tours and bike rentals in Copenhagen. Currency DKK. Two people use
this tool: Federico (Fede) and Søren. Neither writes SQL, and neither will audit
your queries after the initial build, so being right matters more than being
fast.

## Products

Group tours, where strangers buy individual seats:
  A3  Architecture (3h)      L3  Liveable City (3h)
  F3  Food (3.5h)            H3  History (3h)
  A3G Architecture, German   A3F Architecture, French

Private tours, where one group books the whole departure:
  A3P, L3P, F3P, H3P, L2P (2h), and CUSTOM (bespoke, no capacity limit)

Rentals: 1-D through 14-D, where the number is the hire length in days.

Channels: direct, GetYourGuide, Viator, Airbnb, TripAdvisor.
`.trim();

const BEHAVIOUR = `
# How you must answer

You are sceptical by default. A confident wrong answer is the worst thing you
can produce here, far worse than saying you cannot tell. These rules are not
style preferences.

1. Call find_canonical_query BEFORE writing any SQL of your own. If a match is
   strong, run its SQL verbatim. Those queries have the traps already handled;
   yours will not.
2. State "data as of" for every source you touch, in every answer, using the
   real timestamp you were given.
3. Show the SQL you ran. Not so anyone audits it now, but so that when a number
   looks wrong in six months the evidence still exists.
4. Before writing any sentence that sounds causal ("because", "due to", "driven
   by", "X is working"), check it against the inferential limits below. If a
   limit applies, either say so or do not write the sentence.
5. Triangulate a headline number: compute it a second way. If the two disagree
   by more than 1%, report both and flag it rather than picking one.
6. Never join or compute across bc.* and dst.*. Comparing them in words is the
   point; a ratio across them is a fabricated number.
7. Cite at most ONE gap per answer, in one sentence, and only when it is
   genuinely relevant to what was just asked. Never a list. If every answer ends
   in a wishlist, they stop reading them.
8. Aggregate by default. Do not surface customer names, emails or phone numbers
   unless the question is explicitly about an identified customer.
9. If a blocking assertion fails, report the violation INSTEAD of the number.
10. Prefer "I cannot tell from this data" to a plausible guess. Say what you
    cannot know, name the alternative explanations when something is ambiguous,
    and volunteer what extra data would settle it.

## How to cite a gap (amendment_01_sources.md section 8)

11. Say what the gap would unlock FOR THE QUESTION JUST ASKED, not in general.
    "If we had what each guide is paid, I could tell you whether F3 actually
    makes money" is useful. "We should add accounting data" is not.
12. NEVER suggest a gap whose "grain" cannot support the question. If someone
    asks about one departure, monthly regional data is not the answer, and
    offering it is worse than saying nothing. Check the grain before you offer.
13. When a gap has "join_key" starting "none: comparison only", SAY SO when you
    suggest it, so nobody expects a joined analysis that cannot be built. Those
    sources can be compared against in words and never computed with.
14. Still one gap per answer, maximum.
15. Before your final answer, call report_sources_used and name ONLY the sources
    that actually carried it. Everything you queried is already recorded as
    merely referenced; this is for the one or two that the answer depended on.
    Naming everything you touched makes the record useless, and the record is
    how we learn which data is worth keeping.

Gaps also carry a "status". "partial" means bc-fleet already holds some of it
and only the rest is missing: say which half exists, or you will offer to add
data they already have. "ingested" means it is already in the warehouse and is
not a gap at all.

## Two habits that matter more than the rest

SUPPLY VERSUS DEMAND. Low passenger numbers on four departures is not a
measurement of demand, it is a measurement of what was scheduled. Always check
whether departures existed before concluding anything about appetite.
Scheduled-and-empty is evidence of low demand. Not-scheduled is no evidence
either way.

SMALL n. This warehouse holds about six weeks of data. Most products have run a
handful of times. A rate computed over fewer than roughly fifteen departures is
noise, and you should give the raw counts instead of a percentage.

## Style

Plain English for a business owner, not an engineer. Lead with the answer. Give
the real numbers. Do not use em dashes or en dashes as punctuation; use commas,
colons or parentheses. Short paragraphs. No preamble about what you are about
to do.

EXPLAIN, do not just report. Fede, 2026-08-10, on an answer that was a bare
table: "Needs to be more conversational, add nuance, explain. But yes, tables
are good too."

So: keep the table, and put a sentence around it saying what it means and what
is worth noticing. A number without its meaning makes the reader do the
interpreting, and the interpreting is where the mistakes happen.

NEVER let a column name do the explaining. The same day, a query reported
"bikes_allocated: 255" for guided bikes. He owns 9. The number was right (bikes
were taken out 255 times across 76 departures) and every reader would have
understood it as a fleet count. If a figure could be read two ways, say in words
which one it is, and give the comparison number beside it.
`.trim();

/** Compact schema summary: names, columns, one-line descriptions. Not sample data. */
async function schemaSummary() {
  const cols = await db.catalog(`
    SELECT table_name, column_name, data_type, description, gotcha, is_pii
    FROM catalog.columns WHERE schema_name = 'bc'
    ORDER BY table_name, column_name`);

  const sources = await db.catalog(`
    SELECT source_key, description, grain, gotchas FROM catalog.sources ORDER BY source_key`);
  const byKey = new Map(sources.map(s => [s.source_key, s]));

  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, []);
    tables.get(c.table_name).push(c);
  }

  let out = '# The data you can query: schema bc.*\n';
  out += '\nYou may ONLY query bc.*. There is no other schema available to you.\n';

  for (const [table, columns] of tables) {
    const src = byKey.get(`bc.${table}`);
    out += `\n## bc.${table}\n`;
    if (src?.description) out += `${src.description}\n`;
    if (src?.grain) out += `GRAIN: ${src.grain}\n`;
    out += '\n';
    for (const c of columns) {
      const bits = [`  ${c.column_name} (${c.data_type})`];
      if (c.description) bits.push(`— ${String(c.description).replace(/\s+/g, ' ')}`);
      if (c.is_pii) bits.push('[PII]');
      out += bits.join(' ') + '\n';
      if (c.gotcha) out += `      GOTCHA: ${String(c.gotcha).replace(/\s+/g, ' ')}\n`;
    }
    if (src?.gotchas) {
      out += `\n  TABLE GOTCHAS:\n`;
      for (const line of String(src.gotchas).split('\n').filter(Boolean)) {
        out += `    - ${line.trim()}\n`;
      }
    }
  }
  return out;
}

async function definitionsBlock() {
  const defs = await db.catalog(
    `SELECT term, definition, sql_snippet, do_not_use FROM catalog.definitions ORDER BY term`);
  let out = '# The dictionary\n\nThese are agreed definitions. Where one exists, USE IT. Two people query this\ndata and must get the same number for the same question.\n';
  for (const d of defs) {
    out += `\n## ${d.term}\n${d.definition}\n`;
    if (d.sql_snippet) out += `CANONICAL SQL: ${d.sql_snippet}\n`;
    if (d.do_not_use) out += `DO NOT: ${d.do_not_use}\n`;
  }
  return out;
}

async function limitsBlock() {
  const limits = await db.catalog(`SELECT limit_key, rule, applies_to FROM catalog.limits ORDER BY limit_key`);
  let out = '# Inferential limits\n\nCheck these before committing to any causal-sounding sentence (rule 4).\n';
  for (const l of limits) {
    out += `\n## ${l.limit_key}\n${l.rule}\nAPPLIES TO: ${l.applies_to}\n`;
  }
  return out;
}

/**
 * The gaps, with the fields rules 11 to 14 depend on.
 *
 * grain and join_key are the load-bearing ones: without them in the prompt the
 * agent cannot honour "never suggest a gap whose grain cannot support the
 * question" or "say so when it is comparison only". Ranked by cited_count, so
 * the ones that keep blocking real questions surface first.
 */
async function gapsBlock() {
  const rows = await db.catalog(`
    SELECT gap_key, category, missing, unlocks, grain, join_key, effort, status, cited_count
    FROM catalog.gaps WHERE status <> 'rejected'
    ORDER BY cited_count DESC, category, gap_key`);
  if (!rows.length) return '';

  let out = '# What we do NOT have\n\n' +
    'Data that would improve answers but is not in the warehouse. Cite at most\n' +
    'one per answer, only when relevant, and check grain and join_key first.\n' +
    '\n- grain: what one row of it would be. If it cannot answer the question\'s\n' +
    '  level of detail, do not offer it.\n' +
    '- join_key: how it would connect to bc.*. "none: comparison only" means it\n' +
    '  can be compared in words and NEVER computed with (behaviour rule 6).\n' +
    '- status: gap = missing entirely. partial = we hold some of it already, so\n' +
    '  say which half. ingested = already here, not a gap.\n';

  for (const g of rows) {
    out += `\n## ${g.gap_key} (${g.category}, ${g.status}, ${g.effort} effort`;
    if (g.cited_count > 0) out += `, cited ${g.cited_count}x`;
    out += ')\n';
    out += `MISSING: ${String(g.missing).replace(/\s+/g, ' ')}\n`;
    out += `UNLOCKS: ${String(g.unlocks).replace(/\s+/g, ' ')}\n`;
    out += `GRAIN: ${String(g.grain || 'unknown').replace(/\s+/g, ' ')}\n`;
    out += `JOIN: ${String(g.join_key || 'unknown').replace(/\s+/g, ' ')}\n`;
  }
  return out;
}

/**
 * Hand-curated business facts, with their verification status carried through.
 *
 * The source file tags each line (verified) or not, and that tagging is the
 * point: an unconfirmed fact must not reach the agent looking like a confirmed
 * one. The commission rates are the live example, and they are the only
 * untagged line in that file.
 */
async function factsBlock() {
  const rows = await db.catalog(
    `SELECT fact, verified, confirmed_by FROM catalog.business_facts ORDER BY verified DESC, fact_key`)
    .catch(() => []);
  if (!rows.length) return '';
  let out = '# Business facts\n\nTold to us by the people who run the business.\n';
  const conf = rows.filter(r => r.verified);
  const unconf = rows.filter(r => !r.verified);
  if (conf.length) {
    out += '\n## Confirmed\n';
    for (const r of conf) out += `\n- ${String(r.fact).replace(/\s+/g, ' ')}`;
  }
  if (unconf.length) {
    out += '\n\n## NOT confirmed by anybody\n\nYou may use these, but you MUST say they are unconfirmed whenever you do.\n';
    for (const r of unconf) out += `\n- ${String(r.fact).replace(/\s+/g, ' ')}`;
  }
  return out + '\n';
}

/**
 * What Fede and Søren have already settled, from the Doubts queue.
 *
 * Fede, 2026-08-10: "me checking or X doubts should make the model smarter
 * also, so it has fewer doubts in the future."
 *
 * This is the half that makes the queue compound rather than just drain. Every
 * decision goes back into the prompt, so the same ground is not re-litigated:
 * a confirmed thing is stated as settled, and a denial carries the REASON,
 * which is the part that generalises. "No, private tours are 16 not 12" stops
 * the next twenty guesses about capacity, not just that one.
 *
 * Capped and ordered so the block cannot grow without bound: denials first
 * (they carry more information than confirmations), most recent first.
 */
async function settledBlock() {
  const denied = await db.catalog(`
    SELECT subject, question, proposed, note FROM catalog.doubts
    WHERE status = 'denied' AND COALESCE(note,'') <> ''
    ORDER BY decided_at DESC LIMIT 60`).catch(() => []);
  const confirmed = await db.catalog(`
    SELECT subject, question FROM catalog.doubts
    WHERE status = 'confirmed' ORDER BY decided_at DESC LIMIT 40`).catch(() => []);

  if (!denied.length && !confirmed.length) return '';

  let out = '# Already settled\n\nQuestions Fede or Søren have answered. Do not re-open these, and\napply the reasoning to anything similar.\n';

  if (denied.length) {
    out += '\n## Corrected, with the reason\n\nThe model believed something and was told it was wrong. The correction is\nthe important part: it usually applies more widely than the one thing asked.\n';
    for (const d of denied) {
      out += `\n- ${d.subject}: was believed to be "${String(d.proposed || '').replace(/\s+/g, ' ').slice(0, 160)}"\n`;
      out += `  CORRECTED TO: ${String(d.note).replace(/\s+/g, ' ')}\n`;
    }
  }
  if (confirmed.length) {
    out += '\n## Confirmed as correct\n';
    for (const c of confirmed) {
      out += `\n- ${c.subject}: ${String(c.question).replace(/\s+/g, ' ')} YES.`;
    }
  }
  return out + '\n';
}

async function correctionsBlock() {
  // Things the users have said that exist in no database. This is knowledge
  // that would otherwise have died in a chat window.
  const rows = await db.catalog(
    `SELECT correction, context FROM catalog.corrections
     WHERE status IN ('new','applied') ORDER BY said_at`);
  if (!rows.length) return '';
  let out = '# What Fede and Søren have told us\n\nSaid directly by the people who run the business. Trust these over your own\nreasoning about the data.\n';
  for (const r of rows) {
    out += `\n- "${String(r.correction).replace(/\s+/g, ' ')}"`;
    if (r.context) out += `\n  (context: ${String(r.context).replace(/\s+/g, ' ')})`;
  }
  return out + '\n';
}

/** Builds the full static block. Called once at boot and on reload(). */
async function build() {
  const [schema, defs, limits, gaps, facts, settled, corrections] = await Promise.all([
    schemaSummary(), definitionsBlock(), limitsBlock(), gapsBlock(), factsBlock(),
    settledBlock(), correctionsBlock(),
  ]);
  cached = [BUSINESS, defs, schema, limits, gaps, facts, settled, corrections, BEHAVIOUR]
    .filter(Boolean).join('\n\n---\n\n');
  return cached;
}

function get() {
  if (!cached) throw new Error('Static context not built. Call build() at boot.');
  return cached;
}

async function reload() { return build(); }

module.exports = { build, get, reload, BUSINESS, BEHAVIOUR };
