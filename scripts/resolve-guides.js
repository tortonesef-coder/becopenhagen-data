#!/usr/bin/env node
/**
 * Resolves every guide name in the warehouse to a canonical team member id.
 *
 * WHY THIS EXISTS
 * The same person appears under different names in different systems:
 * "Federico Tortonese" in FareHarbor's crew notes is "Federico" in the fleet's
 * team table; "Hasse Sørensen" is Hassan; "Pam" is Paloma. Joining on the name
 * string silently drops guides, and a guide-hours report that quietly omits a
 * person is exactly the kind of confident wrong answer this project exists to
 * prevent.
 *
 * Fede, 2026-08-10: "we don't build naive systems."
 *
 * HOW
 * The matching rules are ported verbatim from bc-fleet's src/guide-name-match.js
 * (accent stripping, known aliases, Levenshtein, word-level matching) so the two
 * apps agree on who is who. Ported rather than imported: bc-data must not depend
 * on bc-fleet's source tree, since that tree is off limits and could move.
 *
 * Writes bc.guide_identity into the warehouse, mapping every distinct guide
 * string ever seen to a member_id. build-warehouse.sql joins to it.
 *
 * ON UNRESOLVED NAMES, and why this does NOT fail the build.
 *
 * Fede, 2026-08-10: "there is a reason why we had lots of different spelling,
 * there is manual input in some parts of the system and we get spelling wrong
 * but the system should still catch it."
 *
 * Guide names are typed by hand into FareHarbor crew notes, so new spellings
 * and genuine typos arrive continuously. An earlier version of this script
 * exited non-zero on any unresolved name, which would have meant one bad typo
 * in a crew note freezing the entire hourly refresh: no fresh bookings, no
 * fresh departures, for everyone, until somebody noticed. That is a far worse
 * failure than one guide showing as unresolved.
 *
 * So: resolve everything resolvable, keep the raw string for anything that is
 * not, and make the unresolved ones LOUD (logged here, surfaced by the
 * unresolved_guide_names assertion, visible on the Sources page). The data
 * keeps flowing and the problem is impossible to miss.
 */

const { execFileSync } = require('child_process');

// BC_WAREHOUSE lets build-warehouse.sh point this at the temp file it is
// building, so guide resolution happens BEFORE the atomic swap. Resolving
// against the live warehouse would mean publishing it unresolved first.
const WAREHOUSE = process.env.BC_WAREHOUSE || '/var/lib/bc-data/warehouse.duckdb';
const DUCKDB = '/usr/local/bin/duckdb';

// ── Ported from bc-fleet/src/guide-name-match.js. Keep in step by hand. ──────
const GUIDE_ALIASES = {
  hassan: ['hasse', 'hassesorensen', 'hassesoerensen'],
  pam: ['paloma'],
};

function normalizeName(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

function guideMatches(availGuide, personName) {
  if (!availGuide || !personName) return false;
  const a = normalizeName(availGuide);
  const p = normalizeName(personName);
  if (!a || !p) return false;

  if (a === p || a.includes(p) || p.includes(a)) return true;

  const personAliases = GUIDE_ALIASES[p] || [];
  if (personAliases.some(al => a === al || a.includes(al) || al.includes(a))) return true;
  for (const [canonical, aliases] of Object.entries(GUIDE_ALIASES)) {
    if (aliases.includes(p) && (a === canonical || a.includes(canonical))) return true;
    if (aliases.some(al => a.includes(al)) && p === canonical) return true;
  }

  const maxDist = Math.max(1, Math.floor(Math.min(a.length, p.length) / 3));
  if (levenshtein(a, p) <= maxDist) return true;

  const aWords = availGuide.toLowerCase().split(/\s+/).map(normalizeName).filter(Boolean);
  const pWords = personName.toLowerCase().split(/\s+/).map(normalizeName).filter(Boolean);
  for (const aw of aWords) {
    for (const pw of pWords) {
      if (aw.length < 3 || pw.length < 3) continue;
      if (aw === pw) return true;
      const d = Math.max(1, Math.floor(Math.min(aw.length, pw.length) / 3));
      if (levenshtein(aw, pw) <= d) return true;
    }
  }
  return false;
}
// ── end port ────────────────────────────────────────────────────────────────

function duckJson(sql, readOnly = true) {
  const args = readOnly ? ['-readonly', WAREHOUSE, '-json', '-c', sql]
                        : [WAREHOUSE, '-json', '-c', sql];
  const out = execFileSync(DUCKDB, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}

const team = duckJson(`SELECT member_id, name, is_guide, active FROM bc.team`);

// Every distinct guide string anywhere in the warehouse, from all three places
// a guide name can appear.
const names = duckJson(`
  SELECT DISTINCT g FROM (
    SELECT guide AS g FROM bc.departures WHERE guide IS NOT NULL AND guide <> ''
    UNION SELECT guide_name FROM bc.guide_hours WHERE guide_name IS NOT NULL AND guide_name <> ''
    UNION SELECT guide_last_logged FROM bc.departures_recovered WHERE guide_last_logged IS NOT NULL AND guide_last_logged <> ''
  ) ORDER BY g`).map(r => r.g);

const rows = [];
const unresolved = [];

for (const raw of names) {
  // Prefer a guide, then any team member: a name should not resolve to a
  // non-guide when a guide also matches.
  const candidates = team.filter(t => guideMatches(raw, t.name));
  const guideMatch = candidates.find(c => c.is_guide) || candidates[0];

  if (!guideMatch) {
    unresolved.push(raw);
    rows.push({ raw, member_id: null, canonical: null, method: 'unresolved' });
    continue;
  }
  const method =
    normalizeName(raw) === normalizeName(guideMatch.name) ? 'exact'
    : normalizeName(raw).includes(normalizeName(guideMatch.name))
      || normalizeName(guideMatch.name).includes(normalizeName(raw)) ? 'substring'
    : (GUIDE_ALIASES[normalizeName(guideMatch.name)] || []).some(a => normalizeName(raw).includes(a)) ? 'alias'
    : 'fuzzy';

  rows.push({ raw, member_id: guideMatch.member_id, canonical: guideMatch.name, method });
  if (candidates.length > 1) {
    console.log(`  note: "${raw}" matched ${candidates.length} people, chose ${guideMatch.name}`);
  }
}

const values = rows.map(r =>
  `(${[r.raw, r.member_id, r.canonical, r.method]
      .map(v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`).join(',')})`
).join(',\n  ');

execFileSync(DUCKDB, [WAREHOUSE, '-c', `
  CREATE OR REPLACE TABLE bc.guide_identity (
    guide_raw   VARCHAR PRIMARY KEY,  -- the string as some system wrote it
    member_id   VARCHAR,              -- canonical id, joins to bc.team
    guide_name  VARCHAR,              -- canonical display name
    match_method VARCHAR              -- exact | substring | alias | fuzzy | unresolved
  );
  ${rows.length ? `INSERT INTO bc.guide_identity VALUES\n  ${values};` : ''}
`], { encoding: 'utf8' });

const byMethod = rows.reduce((a, r) => (a[r.method] = (a[r.method] || 0) + 1, a), {});
console.log(`  guide_identity: ${rows.length} name(s) -> ${new Set(rows.filter(r => r.member_id).map(r => r.member_id)).size} people`,
            JSON.stringify(byMethod));

if (unresolved.length) {
  // Loud, but NOT fatal. See the note at the top of this file: a typo in a
  // hand-typed crew note must never freeze the hourly refresh for everyone.
  console.error(`  WARNING: ${unresolved.length} guide name(s) resolve to nobody: ${unresolved.map(u => `"${u}"`).join(', ')}`);
  console.error('  Their hours and departures are still in the warehouse under the raw name,');
  console.error('  but will not group with that person. Either it is a new guide missing from');
  console.error('  team_members, or a spelling the matcher cannot reach: add it to GUIDE_ALIASES');
  console.error('  here (and, separately, in bc-fleet if the fleet app has the same trouble).');
}
// Always exit 0. The build continues, and the unresolved_guide_names assertion
// carries the problem forward where it will be seen.
process.exit(0);
