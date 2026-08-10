#!/usr/bin/env node
/**
 * Drafts catalog.columns descriptions with one LLM pass over the real schema.
 *
 * The spec is explicit that these must not be hand-written from scratch and
 * must not ship unreviewed. So: this samples actual values out of the warehouse,
 * asks Claude to describe each column, and writes the result with
 * reviewed_by = NULL. The Dictionary page (phase 7) is where Fede corrects them.
 *
 * It is a SCRIPT rather than a one-off because the schema will change. Re-run it
 * after any change to build-warehouse.sql and it will draft the new columns
 * while leaving anything already reviewed by a human alone.
 *
 *   node scripts/bootstrap-columns.js [--dry-run] [--table bc.departures] [--only-missing]
 *
 * --only-missing skips tables that already have drafts, so a run interrupted by
 * an API failure (the 2026-08-10 run stopped halfway when the Anthropic account
 * hit a zero credit balance) can be finished without paying for the work twice.
 *
 * PII: customer names, emails and phone numbers are NEVER sampled or sent. Fede
 * allowed identified rows in query ANSWERS (2026-08-10), which is a different
 * thing from shipping a customer list to the API to write documentation with.
 * Those columns get a hand-written description and an is_pii flag instead.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const WAREHOUSE = '/var/lib/bc-data/warehouse.duckdb';
const CATALOG   = '/var/lib/bc-data/catalog_store.duckdb';
const DUCKDB    = '/usr/local/bin/duckdb';
const MODEL     = process.env.CATALOG_MODEL || 'claude-opus-5';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_TABLE = (() => {
  const i = process.argv.indexOf('--table');
  return i > -1 ? process.argv[i + 1] : null;
})();

// Columns that must never be sampled or sent to the API, with the description
// they get instead. Matched on column name across every table.
const PII_COLUMNS = {
  customer_name:  'The customer who made the booking. Personal data: aggregate by default and only surface when the question is explicitly about an identified customer.',
  customer_email: 'The customer email on the booking. Personal data, same handling as customer_name.',
  customer_phone: 'The customer phone number on the booking. Personal data, same handling as customer_name. Often blank.',
  reviewer_name:  'The name the reviewer left on the public review. Personal data, though usually only a first name.',
};

// pm2 and cron do not inherit /etc/environment, which is where the fleet app
// keeps the shared key, so read it the same way bc-fleet's server.js does.
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const m = fs.readFileSync('/etc/environment', 'utf8')
      .match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  throw new Error('ANTHROPIC_API_KEY not found in the environment or /etc/environment');
}

function duck(db, sql) {
  return execFileSync(DUCKDB, [db, '-json', '-c', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}
function duckJson(db, sql) {
  const out = duck(db, sql).trim();
  return out ? JSON.parse(out) : [];
}

/** Every column in the bc schema, with its type. */
function schema() {
  const rows = duckJson(WAREHOUSE, `
    SELECT table_name, column_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'bc'
    ORDER BY table_name, ordinal_position`);
  const byTable = new Map();
  for (const r of rows) {
    if (ONLY_TABLE && `bc.${r.table_name}` !== ONLY_TABLE) continue;
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }
  return byTable;
}

/**
 * Up to 20 distinct sample values for one column.
 * Ordered by frequency, so the samples show what is TYPICAL rather than a
 * random tail, which is what makes a useful description.
 */
function samples(table, column) {
  if (PII_COLUMNS[column]) return ['(redacted: personal data)'];
  try {
    const rows = duckJson(WAREHOUSE, `
      SELECT CAST("${column}" AS VARCHAR) AS v, COUNT(*) AS n
      FROM bc."${table}" WHERE "${column}" IS NOT NULL
      GROUP BY 1 ORDER BY n DESC, 1 LIMIT 20`);
    return rows.map(r => String(r.v).slice(0, 80));
  } catch {
    return [];
  }
}

function nullStats(table, column) {
  try {
    const [r] = duckJson(WAREHOUSE, `
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE "${column}" IS NULL) AS nulls,
             COUNT(DISTINCT "${column}") AS distinct_vals
      FROM bc."${table}"`);
    return r || { total: 0, nulls: 0, distinct_vals: 0 };
  } catch {
    return { total: 0, nulls: 0, distinct_vals: 0 };
  }
}

// The business context the model needs to describe these columns correctly.
// Without it, it will guess that booking_count means bookings, which is exactly
// the mistake this whole catalog exists to prevent.
const CONTEXT = `
BeCopenhagen runs guided bike tours and bike rentals in Copenhagen. Currency DKK.

Tour codes: A3 architecture, L3 liveability, F3 food, H3 history (group tours,
strangers buy individual seats); A3G German and A3F French variants; A3P, L3P,
F3P, H3P, L2P are PRIVATE versions where one group books the whole departure;
CUSTOM is bespoke group work with no capacity limit. Rentals are coded 1-D
through 14-D, where the number is the rental length in days.

Channels: direct, GetYourGuide, Viator, Airbnb, TripAdvisor.

Critical facts about this specific warehouse, which you must respect:
- All data starts 2026-06-28. There is no earlier history anywhere.
- Passenger counts on departures before 2026-08-03 are ZERO AND WRONG, because
  the departure rows for tours that actually sold were deleted from the source
  database. The pax_is_reliable flag marks this.
- "pax" on a tour departure means PEOPLE. The same underlying column on a rental
  means RESERVATIONS.
- An unsold PRIVATE slot is open capacity, not a tour that ran empty.
- There is NO cancellation flag anywhere. Revenue is gross of cancellations and
  gross of OTA commission.
- Money arrives as text like 'DKK1,200.00' and is parsed into gross_dkk.
- Guide "hours" include a buffer either side (30 min for F3/F3P, 15 for others),
  so they are wall time billed, not tour length.
`.trim();

async function describeTable(table, columns, key) {
  const payload = columns.map(c => ({
    column: c.column_name,
    type: c.data_type,
    ...nullStats(table, c.column_name),
    samples: samples(table, c.column_name),
  }));

  const prompt = `${CONTEXT}

Below are the columns of the table \`bc.${table}\` in this warehouse, each with
its type, row/null/distinct counts, and up to 20 of its most common values.

For EACH column return:
  "description": one or two plain sentences saying what the column actually is.
                 Write for a non-technical business owner, not for an engineer.
  "gotcha":      the specific way someone would misuse THIS column and get a
                 wrong answer, or null if there genuinely isn't one. Do not
                 invent a gotcha to fill the field. Be concrete: name the wrong
                 conclusion, not "be careful".

Ground everything in the samples and counts given. If a column is heavily null,
say so and say what that means. Never guess at business meaning you cannot see
evidence for.

House style: no em dashes or en dashes as punctuation. Use commas or parentheses.

Columns:
${JSON.stringify(payload, null, 1)}

Return ONLY a JSON object mapping column name to {description, gotcha}. No prose.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  // The model occasionally wraps JSON in a fence despite being asked not to.
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return { drafts: JSON.parse(json), usage: body.usage || {} };
}

function sqlStr(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

(async () => {
  const key = apiKey();
  const tables = schema();
  if (!tables.size) { console.error('No bc.* tables found. Has the warehouse been built?'); process.exit(1); }

  console.log(`Drafting column descriptions with ${MODEL} over ${tables.size} tables${DRY_RUN ? ' (dry run)' : ''}\n`);

  // Never overwrite a description a human has already corrected.
  const reviewed = new Set(
    duckJson(CATALOG, `SELECT table_name || '.' || column_name AS k
                       FROM catalog.columns WHERE reviewed_by IS NOT NULL`).map(r => r.k)
  );
  if (reviewed.size) console.log(`${reviewed.size} column(s) already reviewed by a human, leaving those alone.\n`);

  // Tables that already have drafts, so --only-missing can skip them.
  const drafted = new Set(
    duckJson(CATALOG, `SELECT DISTINCT table_name FROM catalog.columns
                       WHERE description IS NOT NULL`).map(r => r.table_name)
  );
  const ONLY_MISSING = process.argv.includes('--only-missing');

  let totalIn = 0, totalOut = 0, written = 0;
  const statements = [];

  for (const [table, columns] of tables) {
    if (ONLY_MISSING && drafted.has(table)) {
      console.log(`  bc.${table} — already drafted, skipping`);
      continue;
    }
    process.stdout.write(`  bc.${table} (${columns.length} cols) ... `);
    let drafts, usage;
    try {
      ({ drafts, usage } = await describeTable(table, columns, key));
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      continue;
    }
    totalIn += usage.input_tokens || 0;
    totalOut += usage.output_tokens || 0;

    for (const c of columns) {
      const name = c.column_name;
      if (reviewed.has(`${table}.${name}`)) continue;

      const isPii = Object.prototype.hasOwnProperty.call(PII_COLUMNS, name);
      const d = drafts[name] || {};
      const description = isPii ? PII_COLUMNS[name] : (d.description || null);
      const gotcha = isPii ? 'Personal data. Aggregate by default; only surface for a question explicitly about one identified customer.' : (d.gotcha || null);
      const sv = isPii ? '(redacted)' : samples(table, name).slice(0, 8).join(' | ');

      statements.push(
        `INSERT OR REPLACE INTO catalog.columns
           (schema_name, table_name, column_name, data_type, description, gotcha,
            sample_values, is_pii, drafted_by, reviewed_by, reviewed_at)
         VALUES ('bc', ${sqlStr(table)}, ${sqlStr(name)}, ${sqlStr(c.data_type)},
                 ${sqlStr(description)}, ${sqlStr(gotcha)}, ${sqlStr(sv)},
                 ${isPii ? 'TRUE' : 'FALSE'}, ${sqlStr(isPii ? 'hand-written (PII)' : MODEL)}, NULL, NULL);`
      );
      written++;
    }
    console.log(`ok (${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out)`);
  }

  if (DRY_RUN) {
    console.log(`\nDry run: ${written} column(s) would be written. Nothing changed.`);
  } else if (statements.length) {
    execFileSync(DUCKDB, [CATALOG, '-c', statements.join('\n')], { encoding: 'utf8' });
    console.log(`\nWrote ${written} column description(s), all with reviewed_by = NULL.`);
  }

  // Rough Opus pricing, only to make the running cost visible from week one as
  // the spec asks. Not billing-accurate.
  const cost = (totalIn / 1e6) * 5 + (totalOut / 1e6) * 25;
  console.log(`Tokens: ${totalIn} in, ${totalOut} out (about $${cost.toFixed(2)}).`);
  console.log('These are DRAFTS. Fede reviews them on the Dictionary page in phase 7.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
