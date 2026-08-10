#!/usr/bin/env node
/**
 * Turns a stored document into a queryable table.
 *
 * Fede, 2026-08-10, on the bike purchase invoice: "the invoice still contains
 * useful data, like when the bikes were purchased, from who, when... feels like
 * a pity to waste this info. I am trying to make a system where there is as
 * little friction as possible to add data to the system."
 *
 * He is right, and the previous behaviour was the waste he describes: a PDF was
 * stored, described, and then nothing in it could be asked about. This is the
 * generalisation of scripts/parse-invoices.js, which proved the approach on the
 * guide invoices.
 *
 * TWO PASSES, and the split is the point:
 *
 *   1. propose a SCHEMA. What columns would this document yield, what does one
 *      row represent. Cheap, and shown to a person before anything is extracted.
 *   2. extract ROWS against that schema.
 *
 * Doing it in one pass invites the model to invent a column when a value is
 * missing, because it is deciding the shape and filling it at the same moment.
 * Fixing the shape first means a missing value comes back as null, which is the
 * truth, rather than as a new column nobody asked for.
 *
 * The output lands as bc.<name> alongside every other source, with the same
 * gotchas discipline: read by a model, reviewed by nobody, and the catalog says
 * so until somebody works the Doubts queue.
 *
 *   node scripts/extract-document.js --upload up_abc123 [--dry-run]
 *   node scripts/extract-document.js --file /path/to.pdf --name bike_purchases
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../src/db');
const ingest = require('../src/ingest');

const MODEL = process.env.CLASSIFY_MODEL || 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const PRICE = { in: 5 / 1e6, out: 25 / 1e6 };
const DUCKDB = '/usr/local/bin/duckdb';
const RAW_DIR = '/var/lib/bc-data/raw';
const WAREHOUSE = '/var/lib/bc-data/warehouse.duckdb';

const arg = f => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes('--dry-run');

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const m = fs.readFileSync('/etc/environment', 'utf8')
    .match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
  return m ? m[1].trim() : null;
}

const SCHEMA_PROPOSAL = {
  type: 'object',
  properties: {
    table_name: { type: 'string', description: 'snake_case, no prefix. e.g. bike_purchases' },
    what_one_row_is: { type: 'string', description: 'The grain. e.g. "one line item on one purchase invoice".' },
    extractable: { type: 'boolean', description: 'False if this document has no repeating structured data worth a table.' },
    why_not: { type: 'string', description: 'If not extractable, why. Empty otherwise.' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'snake_case' },
          type: { type: 'string', enum: ['text', 'number', 'date', 'money', 'boolean'] },
          description: { type: 'string' },
          is_pii: { type: 'boolean' },
        },
        required: ['name', 'type', 'description', 'is_pii'],
        additionalProperties: false,
      },
    },
  },
  required: ['table_name', 'what_one_row_is', 'extractable', 'why_not', 'columns'],
  additionalProperties: false,
};

async function call(key, system, content, schema, maxTokens = 8000) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (/credit balance is too low/i.test(body)) throw new Error('No API credit left.');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const u = body.usage || {};
  return {
    data: JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()),
    cost_usd: (u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out,
  };
}

const docBlock = p => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') },
});

(async () => {
  const key = apiKey();
  if (!key) { console.error('No ANTHROPIC_API_KEY.'); process.exit(1); }

  const uploadId = arg('--upload');
  let filePath = arg('--file');
  let nameHint = arg('--name');
  let upload = null;

  if (uploadId) {
    [upload] = await db.catalog(
      `SELECT * FROM catalog.uploads WHERE upload_id = ${db.esc(uploadId)}`);
    if (!upload) { console.error(`No upload ${uploadId}.`); process.exit(1); }
    filePath = upload.stored_path;
    nameHint = nameHint || String(upload.proposed_key || '').replace(/^bc\./, '');
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Need --upload <id> or --file <path> pointing at a real file.');
    process.exit(1);
  }

  console.log(`Reading ${path.basename(filePath)}\n`);
  let totalUsd = 0;

  // ── Pass 1: what shape is in here? ────────────────────────────────────────
  const { data: schema, cost_usd: c1 } = await call(key, `
You are deciding what table, if any, could be built from a business document.

Propose the columns a person would actually want to query, nothing more. If the
document is a single statement rather than a set of repeating records, say so:
one row is a perfectly good answer, and "not extractable" is better than
inventing structure that is not there.

Do NOT propose a column for a value that appears once as a heading (a supplier
name, an invoice date) UNLESS it belongs on every row. Repeat it on each row if
it does.

House style: no em dashes. snake_case column names.
`.trim(), [docBlock(filePath), { type: 'text', text: `File name: "${path.basename(filePath)}".` +
      (nameHint ? ` Suggested table name: ${nameHint}.` : '') }], SCHEMA_PROPOSAL, 3000);
  totalUsd += c1;

  console.log(`Proposed table: bc.${schema.table_name}`);
  console.log(`One row = ${schema.what_one_row_is}`);
  console.log(`Columns: ${schema.columns.map(c => `${c.name} (${c.type})`).join(', ')}`);
  if (!schema.extractable) {
    console.log(`\nNot extractable: ${schema.why_not}`);
    console.log(`Cost ${(totalUsd * 6.9).toFixed(2)} DKK. Nothing written.`);
    return;
  }

  // ── Pass 2: the rows, against the fixed shape ─────────────────────────────
  //
  // EVERY FIELD IS A STRING. Two reasons, and the second one is not obvious:
  //
  //   * it is the same rule ingest.js follows for uploads. Read faithfully,
  //     cast where the cast is visible and checkable, never let a reader
  //     silently turn "DKK 1.200,50" into NULL.
  //   * a union type per column (string|number|null) is what a nullable field
  //     needs in JSON Schema, and the API rejects a schema with more than a
  //     handful of them: "too many parameters with union types". An 18 column
  //     invoice blows straight through it. Found by running it.
  //
  // Missing values come back as "" and become NULL below.
  const rowSchema = {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: Object.fromEntries(schema.columns.map(c =>
            [c.name, { type: 'string', description: `${c.description} (${c.type}; empty string if the document does not say)` }])),
          required: schema.columns.map(c => c.name),
          additionalProperties: false,
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: 'Anything a person should check by eye. Empty if nothing.' },
    },
    required: ['rows', 'confidence', 'notes'],
    additionalProperties: false,
  };

  const { data: extracted, cost_usd: c2 } = await call(key, `
Extract the rows from this document into the given columns.

Read the values off the page. Do not estimate, do not infer a figure that is not
written down, and use null where the document does not say. A null is a true
answer; a guessed number is a lie that looks like data.

Amounts as plain numbers: 4200.50, never "DKK 4.200,50". Watch for European
formatting where the comma is the decimal separator. Dates as YYYY-MM-DD, and
do not swap day and month on a dd-mm-yyyy document.
`.trim(), [docBlock(filePath), { type: 'text', text:
    `Columns to fill: ${JSON.stringify(schema.columns, null, 1)}\n\nOne row is: ${schema.what_one_row_is}` }],
    rowSchema, 12000);
  totalUsd += c2;

  // "" means the document did not say. Storing it as an empty string instead of
  // NULL would make COUNT(col) and "WHERE col IS NULL" both lie.
  const rows = (extracted.rows || []).map(r =>
    Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, (v === '' || v === undefined) ? null : v])));
  console.log(`\n${rows.length} row(s) extracted, confidence ${extracted.confidence}.`);
  if (extracted.notes) console.log(`Notes: ${extracted.notes}`);
  for (const r of rows.slice(0, 5)) console.log('  ' + JSON.stringify(r));
  if (rows.length > 5) console.log(`  ... and ${rows.length - 5} more`);

  const costDkk = totalUsd * 6.9;
  console.log(`\nCost ${costDkk.toFixed(2)} DKK.`);
  if (!rows.length) { console.log('No rows, nothing to write.'); return; }

  const table = ingest.safeTableName(schema.table_name, uploadId || 'up_doc');
  const outDir = path.join(RAW_DIR, table);
  const parquet = path.join(outDir, `${uploadId || 'doc'}.parquet`);

  // The JSON goes to a scratch file first so the cast check below runs in a dry
  // run too. Knowing that four amounts will not convert is most useful BEFORE
  // deciding to keep the table, not after.
  const jsonPath = DRY
    ? path.join(os.tmpdir(), `bc-extract-${process.pid}.json`)
    : (fs.mkdirSync(outDir, { recursive: true }), path.join(outDir, `${uploadId || 'doc'}.json`));
  fs.writeFileSync(jsonPath, JSON.stringify(rows));

  // Cast to the proposed types with TRY_CAST, which yields NULL rather than
  // failing the whole load. That is convenient and it is also the exact place
  // silent damage happens, so every cast is counted: a value that was present
  // in the JSON and NULL after casting is a number that vanished, and it gets
  // reported and written into the gotchas rather than quietly dropped.
  const DUCK_TYPE = { text: 'VARCHAR', number: 'DOUBLE', money: 'DOUBLE', date: 'DATE', boolean: 'BOOLEAN' };
  const selectList = schema.columns.map(c => {
    const t = DUCK_TYPE[c.type] || 'VARCHAR';
    return t === 'VARCHAR' ? `"${c.name}"` : `TRY_CAST("${c.name}" AS ${t}) AS "${c.name}"`;
  }).join(', ');

  const lostList = schema.columns
    .filter(c => (DUCK_TYPE[c.type] || 'VARCHAR') !== 'VARCHAR')
    .map(c => `SUM(CASE WHEN "${c.name}" IS NOT NULL AND TRY_CAST("${c.name}" AS ${DUCK_TYPE[c.type]}) IS NULL THEN 1 ELSE 0 END) AS "${c.name}"`)
    .join(', ');

  let lost = [];
  if (lostList) {
    const out = execFileSync(DUCKDB, ['-json', '-c',
      `SELECT ${lostList} FROM read_json_auto('${jsonPath}');`], { encoding: 'utf8' });
    const counts = JSON.parse(out || '[{}]')[0] || {};
    lost = Object.entries(counts).filter(([, n]) => Number(n) > 0)
      .map(([col, n]) => `${col} (${n} value${Number(n) === 1 ? '' : 's'})`);
  }
  if (lost.length) {
    console.log(`\nWARNING: values that would not convert to their column type: ${lost.join(', ')}.`);
    console.log('They are stored as NULL. Check them against the document before trusting a total.');
  }

  if (DRY) {
    fs.unlinkSync(jsonPath);
    console.log('\nDry run: nothing written.');
    return;
  }

  // ── Land it as a real source ──────────────────────────────────────────────
  execFileSync(DUCKDB, ['-c',
    `COPY (SELECT ${selectList} FROM read_json_auto('${jsonPath}')) TO '${parquet}' (FORMAT PARQUET, COMPRESSION ZSTD);`],
    { encoding: 'utf8' });
  execFileSync(DUCKDB, [WAREHOUSE, '-c',
    `CREATE SCHEMA IF NOT EXISTS bc; CREATE OR REPLACE TABLE bc."${table}" AS SELECT * FROM read_parquet('${parquet}');`],
    { encoding: 'utf8' });

  const pii = schema.columns.filter(c => c.is_pii).map(c => c.name);
  const gotchas = [
    `EXTRACTED FROM A DOCUMENT BY A MODEL, AND REVIEWED BY NOBODY. The figures are a draft until somebody checks them against ${path.basename(filePath)}.`,
    `The model rated its own reading "${extracted.confidence}".`,
    extracted.notes ? `What it flagged: ${extracted.notes}` : '',
    lost.length ? `VALUES THAT WOULD NOT CONVERT and are stored as NULL: ${lost.join(', ')}. A total over these columns is missing those rows.` : '',
    pii.length ? `Personal data in: ${pii.join(', ')}.` : '',
    `Source document kept at ${filePath}.`,
  ].filter(Boolean).join('\n');

  await db.catalogWrite(`
    INSERT OR REPLACE INTO catalog.sources
      (source_key, display_name, schema_name, layer, description, grain,
       refresh_cadence_hours, retrieval_method, retrieval_instructions, gotchas,
       last_loaded_at, last_row_count, owner)
    VALUES (${db.esc('bc.' + table)}, ${db.esc(schema.table_name.replace(/_/g, ' '))}, 'bc', 'view',
            ${db.esc(`Extracted from the document ${path.basename(filePath)}.`)},
            ${db.esc(schema.what_one_row_is)}, NULL, 'manual',
            ${db.esc(`Re-run: node scripts/extract-document.js --file ${filePath}`)},
            ${db.esc(gotchas)}, now(), ${rows.length}, 'fede');`);

  // data_type is the type the column ACTUALLY has in the warehouse, not the
  // kind the model proposed. The schema block goes into the agent's prompt, and
  // telling it a column is "money" when DuckDB holds a DOUBLE would have it
  // writing casts that are not needed and comparisons that do not work.
  const lostCols = new Set(lost.map(s => s.split(' ')[0]));
  const colValues = schema.columns.map(c =>
    `('bc', ${db.esc(table)}, ${db.esc(c.name)}, ${db.esc(DUCK_TYPE[c.type] || 'VARCHAR')}, ${db.esc(c.description)},` +
    ` ${db.esc(lostCols.has(c.name) ? 'Some values in the document would not convert to this type and are stored as NULL. Check against the original before totalling.' : null)},` +
    ` NULL, ${c.is_pii ? 'TRUE' : 'FALSE'}, ${db.esc(MODEL + ' (document extraction)')}, NULL, NULL)`).join(',');
  await db.catalogWrite(`
    INSERT OR REPLACE INTO catalog.columns
      (schema_name, table_name, column_name, data_type, description, gotcha,
       sample_values, is_pii, drafted_by, reviewed_by, reviewed_at)
    VALUES ${colValues};`);

  if (uploadId) {
    await db.catalogWrite(`
      UPDATE catalog.uploads SET status='ingested', ingested_rows=${rows.length},
        ingested_path=${db.esc(parquet)}, proposed_key=${db.esc('bc.' + table)}
      WHERE upload_id = ${db.esc(uploadId)};`);
    await ingest.writeRebuildScript();
  }

  console.log(`\nLanded as bc.${table} with ${rows.length} row(s).`);
  console.log('Marked read-by-a-model, reviewed-by-nobody. It will appear in the Doubts queue.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
