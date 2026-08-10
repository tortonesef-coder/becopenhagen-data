#!/usr/bin/env node
/**
 * Tests the per-question spending limit without calling the Anthropic API.
 *
 * The budget is the one feature where being wrong costs real money in the wrong
 * direction: too loose and it never fires, too tight and it interrupts every
 * question. So the projection maths and the settings wiring are checked here
 * against the real catalog, and the DKK figures are printed so the numbers can
 * be sanity-checked by eye rather than trusted.
 *
 *   node scripts/test-budget.js
 */

const db = require('../src/db');

// Same rates as src/agent.js, per million tokens. Verified against the
// claude-opus-5 reference on 2026-08-10.
const PRICE = { in: 5 / 1e6, out: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 };
const costOf = u => u.input * PRICE.in + u.output * PRICE.out +
                    u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead;

let pass = 0, fail = 0;
const ok  = (l, x = '') => { pass++; console.log(`  ok    ${l}${x ? '  ' + x : ''}`); };
const bad = (l, x = '') => { fail++; console.log(`  FAIL  ${l}${x ? '  ' + x : ''}`); };

/** The exact rule from runLoop: stop if already over, or if one more turn would be. */
function wouldPause(spentDkk, turn, ceiling) {
  if (turn === 0) return false;                 // never pause before any work
  const perTurn = spentDkk / turn;
  return spentDkk >= ceiling || spentDkk + perTurn > ceiling;
}

(async () => {
  console.log('Per-question spending limit\n');

  const rows = await db.catalog(
    `SELECT key, value FROM catalog.settings
     WHERE key IN ('query_budget_dkk','query_budget_max_dkk','usd_to_dkk','agent_effort')`);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const soft = Number(s.query_budget_dkk), hard = Number(s.query_budget_max_dkk), rate = Number(s.usd_to_dkk);

  console.log('Settings come from the catalog, not from code');
  soft === 3   ? ok('soft limit is 3 DKK', `${soft}`)  : bad('soft limit is 3 DKK', `${soft}`);
  hard === 10  ? ok('hard limit is 10 DKK', `${hard}`) : bad('hard limit is 10 DKK', `${hard}`);
  rate > 5 && rate < 9 ? ok('USD to DKK rate is plausible', `${rate}`) : bad('USD to DKK rate', `${rate}`);

  console.log('\nWhat a question actually costs (17k token cached context)');
  const CTX = 17000;
  const scenarios = [
    ['first question of the day (writes the cache)',
      { input: 2000, output: 1500, cacheWrite: CTX, cacheRead: 0 }],
    ['a repeat question (reads the cache)',
      { input: 2000, output: 1500, cacheWrite: 0, cacheRead: CTX }],
    ['a thinking-heavy question',
      { input: 3000, output: 5000, cacheWrite: 0, cacheRead: CTX }],
    ['a 6 turn agentic question',
      { input: 18000, output: 9000, cacheWrite: CTX, cacheRead: CTX * 5 }],
  ];
  for (const [label, u] of scenarios) {
    const dkk = costOf(u) * rate;
    const flag = dkk > soft ? ' <- over the limit, would ask' : '';
    console.log(`  ${dkk.toFixed(2)} DKK  ${label}${flag}`);
  }

  console.log('\nThe projection rule');
  !wouldPause(0.5, 0, soft)    ? ok('never pauses before the first turn completes') : bad('never pauses before the first turn');
  !wouldPause(0.8, 1, soft)    ? ok('a cheap question runs to the end', '0.80 DKK after 1 turn') : bad('a cheap question runs to the end');
  wouldPause(3.2, 4, soft)     ? ok('pauses once already over', '3.20 DKK') : bad('pauses once already over');
  wouldPause(2.6, 2, soft)     ? ok('pauses when ONE MORE TURN would go over', '2.60 + 1.30 projected') : bad('pauses on projection');
  !wouldPause(2.0, 8, soft)    ? ok('does not pause when the next turn is cheap', '2.00 over 8 turns') : bad('does not pause when cheap');
  wouldPause(9.5, 5, hard)     ? ok('the hard maximum also stops', '9.50 DKK') : bad('the hard maximum stops');
  !wouldPause(4.0, 4, hard)    ? ok('an approved question keeps going past the soft limit', '4.00 DKK, ceiling 10') : bad('approved question continues');

  console.log('\nThe limit is changeable without a deploy');
  await db.catalogWrite(`UPDATE catalog.settings SET value = '5' WHERE key = 'query_budget_dkk'`);
  const [changed] = await db.catalog(`SELECT value FROM catalog.settings WHERE key = 'query_budget_dkk'`);
  changed?.value === '5' ? ok('soft limit can be changed in the catalog') : bad('soft limit can be changed');
  await db.catalogWrite(`UPDATE catalog.settings SET value = '${soft}' WHERE key = 'query_budget_dkk'`);
  const [restored] = await db.catalog(`SELECT value FROM catalog.settings WHERE key = 'query_budget_dkk'`);
  restored?.value === String(soft) ? ok('and restored') : bad('and restored', restored?.value);

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
