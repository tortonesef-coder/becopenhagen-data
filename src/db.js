// DuckDB access.
//
// Two databases, two very different postures:
//
//   warehouse.duckdb    OPENED READ ONLY, ALWAYS. This is what run_sql touches.
//                       Rebuilt and atomically swapped every hour by cron.
//   catalog_store.duckdb  Read-write, but only ever from the small, specific
//                       writers below (query log, gap counts, corrections).
//
// Queries run by spawning the duckdb CLI rather than through a native binding.
// That is a deliberate choice and it buys three things the spec asks for:
//
//   * `-readonly` is enforced by DuckDB itself at the connection level, not by
//     inspecting the SQL string. Spec section 5.1 requires exactly this, and
//     string inspection is defeated by comments, CTEs and clever casing.
//   * A hard timeout, enforced by the OS killing the process, which no
//     in-process query can dodge.
//   * No shared handle to a file that cron replaces underneath us. DuckDB
//     allows a single writer per file; a long-lived connection would fight the
//     hourly rebuild.
//
// The cost is a process spawn per query, roughly 50ms. For a tool used ad hoc,
// a few times a day, that is free.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DUCKDB    = process.env.DUCKDB_BIN || '/usr/local/bin/duckdb';
const WAREHOUSE = process.env.WAREHOUSE_PATH || '/var/lib/bc-data/warehouse.duckdb';
const CATALOG   = process.env.CATALOG_PATH   || '/var/lib/bc-data/catalog_store.duckdb';

const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS || 30000); // spec: 30s
const ROW_CAP          = Number(process.env.ROW_CAP || 5000);           // spec: 5000 rows
const MAX_BUFFER       = 64 * 1024 * 1024;

class QueryError extends Error {
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

async function run(dbPath, sql, { readOnly = true, timeout = QUERY_TIMEOUT_MS } = {}) {
  const args = readOnly
    ? ['-readonly', dbPath, '-json', '-c', sql]
    : [dbPath, '-json', '-c', sql];
  try {
    const { stdout } = await execFileAsync(DUCKDB, args, { timeout, maxBuffer: MAX_BUFFER });
    const out = stdout.trim();
    return out ? JSON.parse(out) : [];
  } catch (e) {
    if (e.killed || e.signal === 'SIGTERM') {
      throw new QueryError(`Query exceeded the ${Math.round(timeout / 1000)} second limit and was stopped.`, 'timeout');
    }
    // DuckDB writes its diagnostics to stderr; that message is far more useful
    // to the model than the generic spawn failure.
    const msg = (e.stderr || e.message || '').trim().split('\n').slice(0, 4).join(' ');
    throw new QueryError(msg || 'Query failed.', 'sql');
  }
}

/** Read-only query against the warehouse. This is what the agent's run_sql uses. */
async function warehouse(sql, opts = {}) {
  return run(WAREHOUSE, sql, { ...opts, readOnly: true });
}

/** Read-only query against the catalog. */
async function catalog(sql, opts = {}) {
  return run(CATALOG, sql, { ...opts, readOnly: true });
}

/**
 * Write to the catalog. Kept separate and used only by the named writers in
 * this file, so there is exactly one place to look when asking "what can this
 * app change".
 */
async function catalogWrite(sql) {
  // Anything past a couple of hundred KB blows the OS argv limit and comes back
  // as a bare "spawn E2BIG", which is a baffling error for what is really "your
  // statement is long". Route big writes through a temp file instead. Hit for
  // real generating 207 doubt rows.
  if (Buffer.byteLength(sql) > 100_000) return catalogWriteBig(sql);
  return run(CATALOG, sql, { readOnly: false, timeout: 15000 });
}

/** Same as catalogWrite, for statements too long to pass as an argument. */
async function catalogWriteBig(sql) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `bcdata-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, sql);
  try {
    await execFileAsync('/bin/sh', ['-c',
      `${DUCKDB} ${JSON.stringify(CATALOG)} < ${JSON.stringify(tmp)}`],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60000 });
    return [];
  } catch (e) {
    throw new QueryError((e.stderr || e.message || '').trim().split('\n').slice(0, 4).join(' '), 'sql');
  } finally {
    fs.unlinkSync(tmp);
  }
}

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Runs a user-or-agent supplied SELECT with the row cap applied.
 *
 * The cap is applied by wrapping the query, not by trusting it to contain a
 * LIMIT. One extra row is fetched so we can tell "exactly 5000 results" from
 * "truncated", which matters: silently truncating a result and reporting it as
 * complete is a wrong answer.
 */
async function runSql(sql) {
  const trimmed = String(sql).trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new QueryError('Empty query.', 'sql');

  const rows = await warehouse(`SELECT * FROM (${trimmed}) LIMIT ${ROW_CAP + 1}`);
  const truncated = rows.length > ROW_CAP;
  if (truncated) rows.length = ROW_CAP;
  return { rows, truncated, rowCount: rows.length };
}

// ── The catalog writers, and the complete list of what this app can change ──

async function logQuery(entry) {
  const cols = ['asked_at', 'username', 'question', 'sql_run', 'result_summary', 'row_count',
    'assertions_fired', 'gap_cited', 'canonical_query_key', 'latency_ms',
    'input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd', 'model', 'error'];
  // asked_at is stamped HERE, not by the caller. agent.js passed null and the
  // whole question history went in undated: "my question history should stay
  // forever" is not worth much if nothing says when anything was asked. The
  // column also has a DEFAULT now(), so this is belt and braces on purpose.
  const vals = cols.map(c =>
    (c === 'asked_at' && entry.asked_at == null) ? 'now()' : esc(entry[c] ?? null)).join(',');
  const [row] = await catalogWrite(
    `INSERT INTO catalog.query_log (id, ${cols.join(',')})
     VALUES (nextval('catalog.query_log_id'), ${vals}) RETURNING id;`);
  return row?.id ?? null;
}

async function logGapHit(gapKey) {
  await catalogWrite(
    `UPDATE catalog.gaps SET cited_count = cited_count + 1 WHERE gap_key = ${esc(gapKey)};`);
}

/**
 * Records something a user said back. Fede, 2026-08-10: what he types in reply
 * to an answer is often a correction about an assumption, and it exists nowhere
 * else. Kept forever.
 */
async function logCorrection({ said_by, correction, context, query_log_id, applies_to }) {
  await catalogWrite(
    `INSERT INTO catalog.corrections (id, said_at, said_by, correction, context, query_log_id, applies_to, status)
     VALUES (nextval('catalog.corrections_id'), now(), ${esc(said_by)}, ${esc(correction)},
             ${esc(context)}, ${esc(query_log_id)}, ${esc(applies_to || 'unclassified')}, 'new');`);
}

module.exports = {
  warehouse, catalog, catalogWrite, runSql,
  logQuery, logGapHit, logCorrection,
  catalogWriteBig,
  esc, QueryError, ROW_CAP, QUERY_TIMEOUT_MS, WAREHOUSE, CATALOG,
};
