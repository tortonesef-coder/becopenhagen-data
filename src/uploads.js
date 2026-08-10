// Taking a file in, and working out enough about it to ask a model what it is.
//
// The pipeline is PROPOSE then CONFIRM. Nothing an upload contains reaches the
// warehouse until a person has looked at the classifier's reading of it and
// said yes. A model reading a spreadsheet header is a good guess, not a fact,
// and a wrong guess registered silently as a source would poison every answer
// built on top of it.
//
// Nothing here writes to the fleet database, ever. Uploads live entirely under
// /var/lib/bc-data/uploads/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/var/lib/bc-data/uploads';
const DUCKDB = process.env.DUCKDB_BIN || '/usr/local/bin/duckdb';

// 64 MB. Big enough for a full FareHarbor export (the largest to date is the
// 3.1 MB customers report), small enough that a mis-drop cannot fill the disk.
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 64 * 1024 * 1024);

// How much of a tabular file the classifier gets to see. Twenty rows is plenty
// to recognise a FareHarbor sales report, and keeps the call cheap.
const PREVIEW_ROWS = 20;

function kindOf(filename, mime) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || mime === 'text/csv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === '.json' || ext === '.ndjson') return 'json';
  if (ext === '.txt' || ext === '.md' || (mime || '').startsWith('text/')) return 'text';
  return 'unknown';
}

function newUploadId() {
  return 'up_' + crypto.randomBytes(9).toString('hex');
}

/** Store an uploaded buffer under its own directory. Returns the record stub. */
function store(buffer, originalName, mimeType, username) {
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)} MB. The limit is ${MAX_BYTES / 1048576} MB.`);
  }
  const uploadId = newUploadId();
  const dir = path.join(UPLOAD_DIR, uploadId);
  fs.mkdirSync(dir, { recursive: true });

  // Never trust the client's filename on disk: basename it and strip anything
  // that is not a safe character, so a crafted name cannot escape the directory.
  const safe = path.basename(String(originalName || 'upload'))
    .replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
  const storedPath = path.join(dir, safe);
  fs.writeFileSync(storedPath, buffer);

  return {
    upload_id: uploadId,
    uploaded_by: username,
    original_name: originalName,
    stored_path: storedPath,
    mime_type: mimeType || null,
    size_bytes: buffer.length,
    file_kind: kindOf(originalName, mimeType),
  };
}

async function duck(sql) {
  const { stdout } = await execFileAsync(DUCKDB, ['-json', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  const out = stdout.trim();
  return out ? JSON.parse(out) : [];
}

const q = s => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Build a preview the classifier can reason about.
 *
 * Tabular files go through DuckDB rather than a CSV parser: it already handles
 * the delimiter sniffing, quoting and encoding mess, it reads xlsx too, and it
 * is the same engine that would ingest the file, so anything it cannot read
 * here it could not have ingested either. That is worth knowing BEFORE a person
 * confirms rather than after.
 *
 * PDFs get no local extraction at all. Claude reads a PDF natively as a
 * document block, layout included, which is both better than any text dump and
 * one dependency fewer.
 */
async function preview(record) {
  const p = record.stored_path;

  if (record.file_kind === 'pdf') {
    return { kind: 'pdf', base64: fs.readFileSync(p).toString('base64') };
  }

  if (record.file_kind === 'csv' || record.file_kind === 'xlsx') {
    const reader = record.file_kind === 'xlsx'
      ? `read_xlsx(${q(p)}, all_varchar = true)`
      : `read_csv(${q(p)}, all_varchar = true, ignore_errors = true, sample_size = -1)`;
    const load = record.file_kind === 'xlsx' ? 'INSTALL excel; LOAD excel;' : '';
    try {
      const cols = await duck(`${load} DESCRIBE SELECT * FROM ${reader};`);
      const rows = await duck(`${load} SELECT * FROM ${reader} LIMIT ${PREVIEW_ROWS};`);
      const [{ n }] = await duck(`${load} SELECT COUNT(*) AS n FROM ${reader};`);
      return {
        kind: 'table',
        columns: cols.map(c => c.column_name),
        rows,
        row_count: n,
        // FareHarbor exports put a title line ABOVE the real header, so the
        // first parsed "column names" are often junk and the real header is
        // row 1. Say so rather than letting the classifier be confused by it.
        note: 'Column names may be wrong if the file has a title line above the real header, which FareHarbor exports do.',
      };
    } catch (e) {
      return { kind: 'unreadable', error: (e.stderr || e.message || '').slice(0, 400) };
    }
  }

  if (record.file_kind === 'json' || record.file_kind === 'text') {
    const head = fs.readFileSync(p, 'utf8').slice(0, 12000);
    return { kind: 'text', text: head, truncated: fs.statSync(p).size > 12000 };
  }

  return { kind: 'unknown' };
}

function remove(uploadId) {
  const dir = path.join(UPLOAD_DIR, path.basename(uploadId));
  if (dir.startsWith(UPLOAD_DIR)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { store, preview, remove, kindOf, UPLOAD_DIR, MAX_BYTES, PREVIEW_ROWS };
