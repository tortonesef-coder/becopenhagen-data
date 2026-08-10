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
  const [schema, defs, limits, corrections] = await Promise.all([
    schemaSummary(), definitionsBlock(), limitsBlock(), correctionsBlock(),
  ]);
  cached = [BUSINESS, defs, schema, limits, corrections, BEHAVIOUR]
    .filter(Boolean).join('\n\n---\n\n');
  return cached;
}

function get() {
  if (!cached) throw new Error('Static context not built. Call build() at boot.');
  return cached;
}

async function reload() { return build(); }

module.exports = { build, get, reload, BUSINESS, BEHAVIOUR };
