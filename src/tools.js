// The agent's tools (spec section 5.1).

const db = require('./db');

const DEFINITIONS = [
  {
    name: 'find_canonical_query',
    description:
      'Search the verified recurring-question queries. YOU MUST CALL THIS BEFORE WRITING ANY SQL OF YOUR OWN. ' +
      'If a returned query strongly matches the question, run its SQL verbatim with run_sql rather than composing your own: ' +
      'these have the data traps already handled and yours will not.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The user question, in their words.' } },
      required: ['question'],
    },
  },
  {
    name: 'search_tables',
    description: 'Full-text search over table and column documentation. Use to find which table holds something.',
    input_schema: {
      type: 'object',
      properties: { keywords: { type: 'string', description: 'Words to search for, e.g. "bike type rental revenue".' } },
      required: ['keywords'],
    },
  },
  {
    name: 'describe_table',
    description: 'Full detail for one table: every column with its description and gotchas, the table-level gotchas, row count and freshness.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Table name, e.g. "bc.departures" or "departures".' } },
      required: ['name'],
    },
  },
  {
    name: 'run_sql',
    description:
      'Run a read-only SELECT against the warehouse. DuckDB syntax. Read-only is enforced by the database itself. ' +
      'Times out at 30 seconds, returns at most 5000 rows, and runs the data assertions over the result.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT or WITH statement.' },
        purpose: { type: 'string', description: 'One short line on what this query is for. Recorded in the query log.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'report_sources_used',
    description:
      'Say which data sources actually CARRIED your answer, as opposed to ones you merely joined or looked at. ' +
      'Call this once, just before your final answer. Only name a source if the answer would change without it: ' +
      '"load_bearing" means the headline number came out of it, "decisive" means it is why the answer says what it ' +
      'says rather than the opposite. Everything you queried is already recorded as merely referenced, so listing ' +
      'a table just because you touched it adds nothing and makes the record less useful.',
    input_schema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          description: 'Only the sources that genuinely mattered. Often one or two. Sometimes none.',
          items: {
            type: 'object',
            properties: {
              source_key: { type: 'string', description: 'e.g. bc.departures' },
              level: { type: 'string', enum: ['load_bearing', 'decisive'] },
              note: { type: 'string', description: 'One short line on what it contributed.' },
            },
            required: ['source_key', 'level', 'note'],
          },
        },
      },
      required: ['sources'],
    },
  },
  {
    name: 'log_gap_hit',
    description:
      'Record that a known data gap was relevant to this question. Call at most ONCE per answer, and only when the gap ' +
      'genuinely blocked a better answer. This ranks the data roadmap.',
    input_schema: {
      type: 'object',
      properties: { gap_key: { type: 'string', description: 'The gap_key from the gaps list.' } },
      required: ['gap_key'],
    },
  },
];

/** Result-level assertions: the checks that apply to an ANSWER, not to a table. */
async function checkResult(sql, rows) {
  const fired = [];
  const lower = String(sql).toLowerCase();

  const assertions = await db.catalog(
    `SELECT assertion_key, message, severity FROM catalog.assertions WHERE target = '*' OR target LIKE 'bc.%'`);
  const byKey = new Map(assertions.map(a => [a.assertion_key, a]));
  const fire = (key, extra) => {
    const a = byKey.get(key);
    if (a) fired.push({ key, severity: a.severity, message: extra ? `${a.message} ${extra}` : a.message });
  };

  // Does the query reach dates where passenger counts are known to be false?
  const touchesPax = /\bpax\b|fill_rate|occupancy|booking_count/.test(lower);
  const filtersReliable = /pax_is_reliable/.test(lower);
  if (touchesPax && !filtersReliable) {
    const mentionsEarly = /2026-0[678]-0[12]|2026-07|2026-06/.test(lower);
    if (mentionsEarly) fire('pax_before_2026_08_03');
  }

  // Unsold private slots counted as departures that ran empty.
  if (/bc\.departures\b/.test(lower) && !/is_real_departure/.test(lower)
      && /count\s*\(|avg\s*\(/.test(lower)) {
    fire('unsold_private_slots');
  }

  // Revenue quoted without the gross caveat.
  if (/gross_dkk/.test(lower)) fire('gross_not_net');

  // The reconstructed table is being used at all.
  if (/departures_recovered/.test(lower)) fire('recovered_departures_overcount');

  // Small n: a rate over too few departures.
  if (/fill_rate|avg\s*\(/.test(lower) && rows.length > 0 && rows.length < 15
      && /fill_rate/.test(lower)) {
    fire('small_n_fill_rate', `This result has ${rows.length} row(s).`);
  }

  // Any date in the result before the warehouse begins means a parsing bug.
  const early = rows.some(r => Object.values(r).some(v =>
    typeof v === 'string' && /^20(1\d|2[0-5])-\d\d-\d\d/.test(v)));
  if (early) fire('history_horizon');

  return fired;
}

async function execute(name, input, ctx) {
  switch (name) {
    case 'find_canonical_query': {
      // Cheap keyword overlap. There are twenty of these, so anything cleverer
      // (embeddings, a vector store) would be machinery for a problem that does
      // not exist at this size (spec section 10).
      const words = String(input.question || '').toLowerCase()
        .split(/[^a-z0-9]+/).filter(w => w.length > 3);
      const all = await db.catalog(
        `SELECT query_key, question_pattern, sql, notes, verified_by FROM catalog.canonical_queries`);
      const scored = all.map(q => {
        const hay = `${q.query_key} ${q.question_pattern}`.toLowerCase();
        return { ...q, score: words.filter(w => hay.includes(w)).length };
      }).filter(q => q.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

      if (!scored.length) return { matches: [], note: 'No canonical query matches. Write your own SQL, carefully.' };
      return {
        matches: scored.map(q => ({
          query_key: q.query_key, matches: q.question_pattern, sql: q.sql, notes: q.notes,
          verified: !!q.verified_by,
        })),
        note: 'These are DRAFTED but not yet verified by Fede (that happens in phase 4). Use a strong match verbatim; still read the notes.',
      };
    }

    case 'search_tables': {
      const words = String(input.keywords || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { results: [] };
      const like = words.map(w =>
        `(lower(table_name) LIKE ${db.esc('%' + w + '%')} OR lower(column_name) LIKE ${db.esc('%' + w + '%')} ` +
        `OR lower(COALESCE(description,'')) LIKE ${db.esc('%' + w + '%')})`).join(' OR ');
      const rows = await db.catalog(
        `SELECT table_name, column_name, data_type, description, gotcha, is_pii
         FROM catalog.columns WHERE ${like} LIMIT 60`);
      return { results: rows.map(r => ({ table: `bc.${r.table_name}`, column: r.column_name,
        type: r.data_type, description: r.description, gotcha: r.gotcha, pii: !!r.is_pii })) };
    }

    case 'describe_table': {
      const t = String(input.name || '').replace(/^bc\./, '');
      const [src] = await db.catalog(
        `SELECT * FROM catalog.sources WHERE source_key = ${db.esc('bc.' + t)}`);
      const cols = await db.catalog(
        `SELECT column_name, data_type, description, gotcha, sample_values, is_pii
         FROM catalog.columns WHERE table_name = ${db.esc(t)} ORDER BY column_name`);
      if (!src && !cols.length) return { error: `No table called bc.${t}. Use search_tables to find the right name.` };
      let count = null;
      try { [{ n: count }] = await db.warehouse(`SELECT COUNT(*) AS n FROM bc."${t}"`); } catch { /* view may not exist */ }
      return {
        table: `bc.${t}`,
        description: src?.description, grain: src?.grain, gotchas: src?.gotchas,
        row_count: count, last_loaded_at: src?.last_loaded_at, max_date_in_data: src?.max_date_in_data,
        columns: cols,
      };
    }

    case 'run_sql': {
      const sql = String(input.sql || '');
      try {
        const { rows, truncated, rowCount } = await db.runSql(sql);
        const fired = await checkResult(sql, rows);
        ctx.sqlRun.push({ sql, purpose: input.purpose || null, rowCount });
        ctx.assertionsFired.push(...fired);

        const blocking = fired.filter(f => f.severity === 'block');
        if (blocking.length) {
          // Rule 9: report the violation INSTEAD of the number. The rows are
          // deliberately withheld so the model cannot quote them anyway.
          return {
            blocked: true,
            assertions: blocking,
            note: 'A BLOCKING assertion failed. Report this to the user instead of the numbers. Do not work around it by rephrasing the query.',
          };
        }
        return {
          row_count: rowCount,
          truncated: truncated ? `Truncated at ${db.ROW_CAP} rows. Say so, or aggregate instead.` : false,
          warnings: fired.filter(f => f.severity === 'warn'),
          rows: rows.slice(0, 200),
          note: rows.length > 200 ? `Showing the first 200 of ${rowCount} rows.` : undefined,
        };
      } catch (e) {
        return { error: e.message, kind: e.kind || 'error',
          note: 'Fix the query and try again. Use describe_table if you are unsure of a column.' };
      }
    }

    case 'report_sources_used': {
      const list = Array.isArray(input.sources) ? input.sources : [];
      ctx.contributions = list;
      return { recorded: list.length,
        note: list.length ? 'Noted.' : 'Noted: nothing beyond the obvious carried this answer.' };
    }

    case 'log_gap_hit': {
      if (ctx.gapCited) return { note: 'A gap has already been cited for this answer. Rule 7 allows only one.' };
      const [gap] = await db.catalog(
        `SELECT gap_key, missing, unlocks, how_to_get FROM catalog.gaps WHERE gap_key = ${db.esc(input.gap_key)}`);
      if (!gap) return { error: `No gap called ${input.gap_key}.` };
      await db.logGapHit(gap.gap_key);
      ctx.gapCited = gap.gap_key;
      return { logged: true, gap };
    }

    default:
      return { error: `Unknown tool ${name}.` };
  }
}

module.exports = { DEFINITIONS, execute, checkResult };
