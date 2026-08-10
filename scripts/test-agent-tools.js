#!/usr/bin/env node
/**
 * Exercises every agent tool and the result-level assertions WITHOUT calling
 * the Anthropic API.
 *
 * This is the important test. The API call is the easy part; what actually
 * keeps the tool honest is that run_sql is genuinely read-only, that the row
 * cap and timeout hold, and above all that the July trap is BLOCKED rather than
 * answered. That last one is the reason this project exists, and it must be
 * provable without spending a cent.
 *
 *   node scripts/test-agent-tools.js
 */

const db = require('../src/db');
const tools = require('../src/tools');

let pass = 0, fail = 0;
const ok  = (label, extra = '') => { pass++; console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`); };
const bad = (label, extra = '') => { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); };
const ctx = () => ({ sqlRun: [], assertionsFired: [], gapCited: null, canonicalUsed: null });

(async () => {
  console.log('Agent tools and safety, no API calls\n');

  console.log('run_sql is genuinely read-only');
  for (const [label, sql] of [
    ['CREATE is refused',  'CREATE TABLE bc.hack (x INT)'],
    ['DROP is refused',    'DROP TABLE bc.departures'],
    ['UPDATE is refused',  'UPDATE bc.departures SET pax = 999'],
    ['DELETE is refused',  'DELETE FROM bc.bookings'],
    ['ATTACH is refused',  "ATTACH '/var/www/becopenhagen-fleet/data/fleet.db' AS f"],
  ]) {
    const r = await tools.execute('run_sql', { sql }, ctx());
    if (r.error) ok(label); else bad(label, JSON.stringify(r).slice(0, 90));
  }

  // The fleet database must be unreachable from here even by name.
  {
    const r = await tools.execute('run_sql', { sql: 'SELECT * FROM fleet_raw.bookings LIMIT 1' }, ctx());
    if (r.error) ok('the live fleet database is not reachable'); else bad('the live fleet database is not reachable');
  }

  console.log('\nLimits hold');
  {
    const r = await tools.execute('run_sql', { sql: 'SELECT * FROM range(10000)' }, ctx());
    if (r.truncated && r.row_count === db.ROW_CAP) ok(`row cap at ${db.ROW_CAP}`, `got ${r.row_count}, flagged truncated`);
    else bad('row cap', JSON.stringify({ n: r.row_count, t: r.truncated }));
  }
  {
    // Test the timeout MECHANISM with a short deadline rather than waiting the
    // full 30 seconds. Note also that COUNT(*) FROM range(n) is not a slow
    // query however large n is: DuckDB answers it from the range cardinality
    // without materialising anything. A real cross join is needed to make it
    // work. (The first version of this test used the count and "passed" by
    // returning in 23s, which proved nothing.)
    const started = Date.now();
    let timedOut = false;
    try {
      await db.warehouse('SELECT sum(a.range * b.range) FROM range(300000) a, range(300000) b',
        { timeout: 2000 });
    } catch (e) {
      timedOut = e.kind === 'timeout';
    }
    const secs = (Date.now() - started) / 1000;
    if (timedOut && secs < 10) ok('the timeout mechanism kills a long query', `2s deadline honoured in ${secs.toFixed(1)}s`);
    else bad('the timeout mechanism kills a long query', `${secs.toFixed(1)}s, timedOut=${timedOut}`);
    console.log(`  note  run_sql is configured with a ${db.QUERY_TIMEOUT_MS / 1000}s deadline and a ${db.ROW_CAP} row cap`);
  }

  console.log('\nTHE JULY TRAP: the answer this whole project exists to prevent');
  {
    // Exactly what a naive "how did July go" would run.
    const c = ctx();
    const r = await tools.execute('run_sql', {
      sql: `SELECT COUNT(*) AS departures, SUM(pax) AS pax FROM bc.departures
            WHERE departure_date BETWEEN DATE '2026-07-01' AND DATE '2026-07-31'`,
    }, c);
    if (r.blocked && r.assertions?.some(a => a.key === 'pax_before_2026_08_03')) {
      ok('July passenger query is BLOCKED, numbers withheld');
    } else {
      bad('July passenger query is BLOCKED', JSON.stringify(r).slice(0, 160));
    }
  }
  {
    // The same question asked correctly must still work.
    const r = await tools.execute('run_sql', {
      sql: `SELECT COUNT(*) AS departures, SUM(pax) AS pax FROM bc.departures
            WHERE pax_is_reliable AND departure_date >= DATE '2026-08-03'`,
    }, ctx());
    if (!r.blocked && r.row_count === 1) ok('the same question asked properly still answers');
    else bad('the same question asked properly still answers', JSON.stringify(r).slice(0, 120));
  }

  console.log('\nWarnings fire where they should');
  {
    const r = await tools.execute('run_sql',
      { sql: 'SELECT SUM(gross_dkk) AS revenue FROM bc.bookings' }, ctx());
    if (r.warnings?.some(w => w.key === 'gross_not_net')) ok('revenue carries the gross-of-commission warning');
    else bad('revenue carries the gross-of-commission warning', JSON.stringify(r.warnings));
  }
  {
    const r = await tools.execute('run_sql',
      { sql: 'SELECT COUNT(*) FROM bc.departures WHERE product_kind = \'private_tour\'' }, ctx());
    if (r.warnings?.some(w => w.key === 'unsold_private_slots')) ok('counting departures warns about unsold private slots');
    else bad('counting departures warns about unsold private slots', JSON.stringify(r.warnings));
  }
  {
    const r = await tools.execute('run_sql',
      { sql: 'SELECT * FROM bc.departures_recovered LIMIT 5' }, ctx());
    if (r.warnings?.some(w => w.key === 'recovered_departures_overcount')) ok('the reconstructed table warns about its 43% over-count');
    else bad('the reconstructed table warns about its over-count', JSON.stringify(r.warnings));
  }

  console.log('\nThe other tools');
  {
    const r = await tools.execute('find_canonical_query', { question: 'how full are our tours' }, ctx());
    if (r.matches?.some(m => m.query_key === 'fill_rate_by_product')) ok('find_canonical_query finds the fill rate query');
    else bad('find_canonical_query finds the fill rate query', JSON.stringify(r).slice(0, 120));
  }
  {
    const r = await tools.execute('search_tables', { keywords: 'guide hours' }, ctx());
    if (r.results?.length) ok('search_tables finds guide hours', `${r.results.length} hits`);
    else bad('search_tables finds guide hours');
  }
  {
    const r = await tools.execute('describe_table', { name: 'bc.departures' }, ctx());
    const hasFlag = r.columns?.some(c => c.column_name === 'pax_is_reliable');
    if (r.gotchas && hasFlag && r.row_count > 0) ok('describe_table returns gotchas and columns', `${r.row_count} rows`);
    else bad('describe_table returns gotchas and columns');
  }
  {
    const c = ctx();
    const r1 = await tools.execute('log_gap_hit', { gap_key: 'history_pre_2026' }, c);
    const r2 = await tools.execute('log_gap_hit', { gap_key: 'july_departures' }, c);
    if (r1.logged && !r2.logged) ok('only one gap can be cited per answer (rule 7)');
    else bad('only one gap can be cited per answer', JSON.stringify({ r1: !!r1.logged, r2: !!r2.logged }));
  }
  {
    const r = await tools.execute('describe_table', { name: 'bc.nonexistent' }, ctx());
    if (r.error) ok('an unknown table returns a helpful error, not a crash');
    else bad('an unknown table returns a helpful error');
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
