// Recording which sources actually earned their place in an answer.
//
// The naive version of this feature is worse than not having it. If you log
// every table that appears in a query, bc.departures wins every time and the
// number tells you nothing except which table is convenient to join. So there
// are three levels, and the split is the whole point:
//
//   referenced    it appeared in the SQL. Parsed from the query, objective.
//   load_bearing  the headline number came out of it. The agent says so.
//   decisive      it changed the conclusion.
//
// The interesting signal is the RATIO. A source referenced forty times and
// never load-bearing is being joined out of habit; a source referenced twice
// and decisive both times is carrying real weight for its size.

const db = require('./db');

/**
 * Which bc.* tables a query actually touches.
 *
 * Deliberately simple string matching rather than a SQL parser. A parser would
 * be more correct and would also be a dependency, a maintenance burden and a
 * new way to crash the answer path. The failure mode here is over-reporting (a
 * table named in a comment counts), and over-reporting at the 'referenced'
 * level is harmless because 'referenced' is the level that already means very
 * little on its own.
 */
function tablesIn(sql) {
  const found = new Set();
  const re = /\bbc\.("?)([a-z_][a-z0-9_]*)\1/gi;
  let m;
  while ((m = re.exec(String(sql || '')))) found.add(`bc.${m[2].toLowerCase()}`);
  return [...found];
}

/**
 * Record usage for one answered question.
 *
 * @param {object[]} sqlRun        what the agent ran
 * @param {object[]} contributions [{source_key, level, note}] as reported by the agent
 */
async function record({ queryLogId, username, sqlRun = [], contributions = [] }) {
  const referenced = new Set();
  for (const s of sqlRun) for (const t of tablesIn(s.sql)) referenced.add(t);

  // What the agent claimed, keyed by source. Its judgement wins where it made
  // one; everything else it touched is merely referenced.
  const claimed = new Map();
  for (const c of contributions) {
    if (!c || !c.source_key) continue;
    const key = String(c.source_key).startsWith('bc.') ? c.source_key : `bc.${c.source_key}`;
    if (!['load_bearing', 'decisive'].includes(c.level)) continue;
    // A source the agent claims but never queried is not usage, it is a
    // hallucinated citation. Drop it rather than record it.
    if (!referenced.has(key)) continue;
    claimed.set(key, { level: c.level, note: c.note || null });
  }

  const rows = [...referenced].map(key => ({
    key,
    level: claimed.get(key)?.level || 'referenced',
    note: claimed.get(key)?.note || null,
  }));
  if (!rows.length) return 0;

  const values = rows.map(r =>
    `(nextval('catalog.source_usage_id'), now(), ${db.esc(r.key)}, ${db.esc(queryLogId)},` +
    ` ${db.esc(username)}, ${db.esc(r.level)}, ${db.esc(r.note)}, FALSE)`).join(',');

  await db.catalogWrite(`
    INSERT INTO catalog.source_usage
      (usage_id, used_at, source_key, query_log_id, username, level, note, corrected)
    VALUES ${values};`);
  return rows.length;
}

/**
 * A correction downgrades the usage it was attached to.
 *
 * If Fede says the answer was wrong, the sources that carried it did not serve,
 * whatever the agent claimed at the time. Without this the usefulness numbers
 * only ever go up, which would make them a popularity contest rather than a
 * measure of whether the data helped.
 */
async function markCorrected(queryLogId) {
  if (queryLogId == null) return;
  await db.catalogWrite(
    `UPDATE catalog.source_usage SET corrected = TRUE WHERE query_log_id = ${db.esc(queryLogId)};`);
}

/** The usefulness picture, for the Sources page and for the curator. */
async function summary() {
  return db.catalog(`
    SELECT source_key,
           COUNT(*)                                              AS times_used,
           COUNT(*) FILTER (WHERE level IN ('load_bearing','decisive')) AS times_mattered,
           COUNT(*) FILTER (WHERE level = 'decisive')            AS times_decisive,
           COUNT(*) FILTER (WHERE corrected)                     AS in_corrected_answers,
           MAX(used_at)                                          AS last_used
    FROM catalog.source_usage
    GROUP BY 1 ORDER BY times_mattered DESC, times_used DESC`);
}

module.exports = { record, markCorrected, summary, tablesIn };
