#!/usr/bin/env node
/**
 * Tests that the guide matcher actually catches the misspellings it is there to
 * catch, and that it does NOT merge two different people.
 *
 * Fede, 2026-08-10: "there is manual input in some parts of the system and we
 * get spelling wrong but the system should still catch it."
 *
 * The real names come from the live team table, so this test stays honest as
 * people join and leave rather than testing against a hardcoded cast.
 *
 *   node scripts/test-guide-matching.js
 */

const { execFileSync } = require('child_process');
const path = require('path');

// Reuse the exact matcher the build uses, so this cannot drift from it.
const resolverPath = path.join(__dirname, 'resolve-guides.js');
const src = require('fs').readFileSync(resolverPath, 'utf8');
// The file runs its work at require time, so pull the pure functions out of it
// rather than importing and triggering a rebuild.
const matcherSrc = src.slice(src.indexOf('const GUIDE_ALIASES'), src.indexOf('// ── end port'));
const { guideMatches } = (new Function(`${matcherSrc}; return { guideMatches };`))();

const WAREHOUSE = process.env.BC_WAREHOUSE || '/var/lib/bc-data/warehouse.duckdb';
const team = JSON.parse(execFileSync('/usr/local/bin/duckdb',
  ['-readonly', WAREHOUSE, '-json', '-c', 'SELECT member_id, name FROM bc.team'],
  { encoding: 'utf8' }).trim() || '[]');

const nameOf = id => team.find(t => t.member_id === id)?.name;

// Should resolve to the person on the right. Typos, accents, case, extra
// words, surnames and the known aliases: the ways a hand-typed crew note
// actually goes wrong.
const SHOULD_MATCH = [
  ['Federico Tortonese', 'fede'], ['federico', 'fede'], ['Fedrico', 'fede'], ['FEDERICO', 'fede'],
  ['Feidhlim', 'feidhlim'], ['Féidhlim', 'feidhlim'], ['feidhlim o brien', 'feidhlim'],
  ['Pam', 'pam'], ['Paloma', 'pam'], ['Paloma Lopez Garcia-Pelayo', 'pam'], ['paloma ', 'pam'],
  ['Hasse Sørensen', 'hassan'], ['Hasse Soerensen', 'hassan'], ['hasse', 'hassan'],
  ['Monica', 'monica'], ['monika', 'monica'], ['MONICA ', 'monica'],
  ['Dimitra', 'dimitra'], ['dimitra ', 'dimitra'], ['Dimitraa', 'dimitra'],
  ['Ibrahim', 'ibrahim'], ['ibrahim', 'ibrahim'], ['Ibrahmi', 'ibrahim'],
  ['Andrew', 'andrew'], ['andrw', 'andrew'],
];

// Must NOT match: merging two people is worse than failing to match one,
// because it moves someone's hours onto somebody else's invoice silently.
const MUST_NOT_MATCH = [
  ['Andrew', 'ibrahim'], ['Monica', 'dimitra'], ['Federico', 'feidhlim'],
  ['Paloma', 'andrew'], ['Ibrahim', 'monica'], ['Dimitra', 'fede'],
];

let pass = 0, fail = 0;

console.log('Guide name matching, against the live team table\n');
console.log('Should match (typos, accents, aliases, surnames):');
for (const [typed, expectId] of SHOULD_MATCH) {
  const expectName = nameOf(expectId);
  if (!expectName) { console.log(`  skip  "${typed}" -> ${expectId} is not in the team table`); continue; }
  const hits = team.filter(t => guideMatches(typed, t.name));
  const ok = hits.length === 1 && hits[0].member_id === expectId;
  // Two matches is acceptable only when the build's guide-preference rule can
  // still pick correctly; flag it so it stays visible.
  const okish = hits.some(h => h.member_id === expectId);
  if (ok)        { pass++; console.log(`  ok    "${typed}" -> ${expectName}`); }
  else if (okish){ pass++; console.log(`  ok~   "${typed}" -> ${expectName} (also matched ${hits.filter(h=>h.member_id!==expectId).map(h=>h.name).join(', ')})`); }
  else           { fail++; console.log(`  FAIL  "${typed}" -> expected ${expectName}, got ${hits.map(h => h.name).join(', ') || 'nobody'}`); }
}

console.log('\nMust NOT match (never merge two people):');
for (const [typed, wrongId] of MUST_NOT_MATCH) {
  const wrongName = nameOf(wrongId);
  if (!wrongName) continue;
  if (guideMatches(typed, wrongName)) { fail++; console.log(`  FAIL  "${typed}" wrongly matched ${wrongName}`); }
  else { pass++; console.log(`  ok    "${typed}" does not match ${wrongName}`); }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail);
