// Turning a confirmed upload into a real source.
//
// Only reached after a person has read the classifier's proposal and said yes.
// Three things happen, in this order, and all three or none:
//
//   1. the file is written to Parquet under raw/, which is the durable copy;
//   2. a table is created in the warehouse from that Parquet;
//   3. it is registered in catalog.sources, and any gap it fills flips to
//      'ingested' so the agent stops offering to add data we now have.
//
// Step 2 is deliberately re-done by the hourly rebuild rather than left as a
// one-off: build-warehouse.sql drops and recreates the warehouse every hour, so
// an uploaded table has to be re-created from its Parquet each time or it would
// vanish within the hour. sql/build-uploads.sql does that, generated from the
// catalog so nothing has to be hand-edited when a file is added.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const db = require('./db');

const DUCKDB = process.env.DUCKDB_BIN || '/usr/local/bin/duckdb';
const RAW_DIR = process.env.RAW_DIR || '/var/lib/bc-data/raw';
const WAREHOUSE = process.env.WAREHOUSE_PATH || '/var/lib/bc-data/warehouse.duckdb';

const q = s => `'${String(s).replace(/'/g, "''")}'`;

/** A safe bc.* table name. The model proposes; this decides. */
function safeTableName(proposed, uploadId) {
  const base = String(proposed || '').replace(/^bc\./, '')
    .toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return base && /^[a-z]/.test(base) ? base : `upload_${uploadId.replace(/^up_/, '')}`;
}

async function duckExec(dbPath, sql, timeout = 120000) {
  const args = dbPath ? [dbPath, '-c', sql] : ['-c', sql];
  return execFileAsync(DUCKDB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
}

/**
 * Convert the upload to Parquet and register it.
 *
 * PDFs are NOT ingested as a table: a PDF is a document, not a dataset. They
 * are kept, recorded, and left for a purpose-built parser (see
 * scripts/parse-invoices.js for the guide invoices). Pretending a PDF is a
 * table would produce one row of nonsense.
 */
async function ingest(upload) {
  const table = safeTableName(upload.proposed_key, upload.upload_id);
  const outDir = path.join(RAW_DIR, table);
  fs.mkdirSync(outDir, { recursive: true });
  const parquet = path.join(outDir, `${upload.upload_id}.parquet`);

  if (upload.file_kind === 'pdf') {
    throw Object.assign(new Error('PDFs are kept as documents, not ingested as tables.'),
      { friendly: 'This is a PDF, so there is no table to load. It has been stored and recorded; a parser can read it (the guide invoices work this way).' });
  }

  const reader = upload.file_kind === 'xlsx'
    ? `read_xlsx(${q(upload.stored_path)}, all_varchar = true)`
    : `read_csv(${q(upload.stored_path)}, all_varchar = true, ignore_errors = true, sample_size = -1)`;
  const load = upload.file_kind === 'xlsx' ? 'INSTALL excel; LOAD excel;' : '';

  // Everything lands as VARCHAR on purpose. Type inference on a FareHarbor
  // export is exactly where silent damage happens: a money column reading
  // "DKK1,200.00" becomes NULL, a date in dd/mm/yyyy becomes the wrong day.
  // Store faithfully, cast in the view where the cast is visible and testable.
  await duckExec(null, `${load} COPY (SELECT * FROM ${reader}) TO ${q(parquet)} (FORMAT PARQUET, COMPRESSION ZSTD);`);

  const { stdout } = await execFileAsync(DUCKDB,
    ['-noheader', '-list', '-c', `SELECT COUNT(*) FROM read_parquet(${q(parquet)});`],
    { encoding: 'utf8' });
  const rows = Number(String(stdout).trim()) || 0;

  // Create it in the live warehouse now, so it is usable immediately rather
  // than after the next hourly rebuild.
  await duckExec(WAREHOUSE,
    `CREATE SCHEMA IF NOT EXISTS bc;
     CREATE OR REPLACE TABLE bc."${table}" AS SELECT * FROM read_parquet(${q(parquet)});`);

  return { table, parquet, rows };
}

/**
 * Register the ingested file in catalog.sources, and close any gap it fills.
 *
 * The gotchas column is assembled from the classifier's caveats plus the
 * provenance, because a source nobody can trace is a source nobody should
 * trust: six months from now the only way to know where a number came from is
 * what is written here.
 */
async function register(upload, { table, parquet, rows }) {
  const cols = typeof upload.columns_json === 'string'
    ? JSON.parse(upload.columns_json || '[]') : (upload.columns_json || []);
  const pii = cols.filter(c => c.is_pii).map(c => c.name);

  const gotchas = [
    upload.caveats || '',
    `Uploaded by ${upload.uploaded_by} on ${String(upload.uploaded_at).slice(0, 16)} from the file "${upload.original_name}".`,
    `Classified automatically by ${upload.classifier_model}; the reading was confirmed by ${upload.decided_by} but the column descriptions were NOT hand-checked.`,
    pii.length ? `Personal data in: ${pii.join(', ')}.` : '',
    `Every column is stored as text exactly as it appeared in the file. Cast in the query, and check the cast.`,
  ].filter(Boolean).join('\n');

  await db.catalogWrite(`
    INSERT OR REPLACE INTO catalog.sources
      (source_key, display_name, schema_name, layer, description, grain,
       refresh_cadence_hours, retrieval_method, retrieval_instructions, gotchas,
       last_loaded_at, last_row_count, owner)
    VALUES (${q('bc.' + table)}, ${q(upload.proposed_name)}, 'bc', 'view',
            ${q(upload.what_it_is)}, ${q(upload.grain)},
            NULL, 'manual',
            ${q(`Uploaded by hand on the Sources page. The original file is kept at ${upload.stored_path}; the durable copy is ${parquet}. To refresh, upload a newer export.`)},
            ${q(gotchas)}, now(), ${rows}, 'fede');`);

  // Column descriptions from the classifier, marked unreviewed like every other
  // drafted description.
  if (cols.length) {
    const values = cols.map(c =>
      `('bc', ${q(table)}, ${q(c.name)}, ${q(c.type || 'VARCHAR')}, ${q(c.description || '')},` +
      ` NULL, NULL, ${c.is_pii ? 'TRUE' : 'FALSE'}, ${q(upload.classifier_model + ' (upload classifier)')}, NULL, NULL)`
    ).join(',\n');
    await db.catalogWrite(`
      INSERT OR REPLACE INTO catalog.columns
        (schema_name, table_name, column_name, data_type, description, gotcha,
         sample_values, is_pii, drafted_by, reviewed_by, reviewed_at)
      VALUES ${values};`);
  }

  // Close the gap, if the classifier matched one and the person agreed.
  if (upload.fills_gap) {
    await db.catalogWrite(`
      UPDATE catalog.gaps SET status = 'ingested',
        how_to_get = ${q(`INGESTED ${String(new Date().toISOString()).slice(0, 10)} from the upload "${upload.original_name}". Now available as bc.${table}.`)}
      WHERE gap_key = ${q(upload.fills_gap)};`);
  }

  return { table, rows, gap_closed: upload.fills_gap || null };
}

/**
 * Regenerate sql/build-uploads.sql so the hourly rebuild recreates every
 * uploaded table from its Parquet. Without this an upload disappears at :35.
 */
async function writeRebuildScript() {
  const rows = await db.catalog(`
    SELECT proposed_key, ingested_path FROM catalog.uploads
    WHERE status = 'ingested' AND ingested_path IS NOT NULL ORDER BY uploaded_at`);

  let sql = `-- GENERATED by src/ingest.js. Do not edit by hand.
--
-- Recreates every confirmed upload in the warehouse from its Parquet copy.
-- build-warehouse.sql drops and rebuilds the warehouse hourly, so without this
-- an uploaded table would vanish within the hour of being confirmed.

CREATE SCHEMA IF NOT EXISTS bc;
`;
  for (const r of rows) {
    const t = safeTableName(r.proposed_key, 'x');
    sql += `\nCREATE OR REPLACE TABLE bc."${t}" AS SELECT * FROM read_parquet('${r.ingested_path}');\n`;
  }
  if (!rows.length) sql += '\n-- No uploads ingested yet.\n';

  fs.writeFileSync(path.join(__dirname, '../sql/build-uploads.sql'), sql);
  return rows.length;
}

module.exports = { ingest, register, writeRebuildScript, safeTableName };
