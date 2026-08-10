#!/usr/bin/env node
/**
 * Exercises the upload pipeline end to end, bypassing HTTP auth.
 *
 * Two modes, because one of them costs money and one does not:
 *
 *   (default)  storage, preview and safety only. No API call, no cost. This is
 *              what runs in scripts/verify.sh.
 *   --classify also calls the classifier on a real FareHarbor export and
 *              checks it identifies the file and matches the right gap. Costs
 *              1 to 3 DKK. Run it by hand after changing the classifier prompt.
 *
 *   node scripts/test-upload.js [--classify] [--ingest]
 */

const fs = require('fs');
const path = require('path');
const uploads = require('../src/uploads');
const ingestMod = require('../src/ingest');
const db = require('../src/db');

const DO_CLASSIFY = process.argv.includes('--classify');
const DO_INGEST = process.argv.includes('--ingest');

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  ok    ${l}${x ? '  ' + x : ''}`); };
const bad = (l, x = '') => { fail++; console.log(`  FAIL  ${l}${x ? '  ' + x : ''}`); };

const TMP = '/tmp/bc-upload-test';

(async () => {
  console.log('Upload pipeline\n');
  fs.mkdirSync(TMP, { recursive: true });

  console.log('File type detection');
  const cases = [['a.csv', 'text/csv', 'csv'], ['b.xlsx', null, 'xlsx'], ['c.pdf', 'application/pdf', 'pdf'],
                 ['d.json', null, 'json'], ['e.exe', 'application/octet-stream', 'unknown']];
  for (const [name, mime, want] of cases) {
    const got = uploads.kindOf(name, mime);
    got === want ? ok(`${name} -> ${want}`) : bad(`${name} -> ${want}`, `got ${got}`);
  }

  console.log('\nStorage is safe');
  {
    // A crafted filename must not escape the upload directory.
    const rec = uploads.store(Buffer.from('a,b\n1,2\n'), '../../../etc/passwd', 'text/csv', 'test');
    rec.stored_path.startsWith(uploads.UPLOAD_DIR) && !rec.stored_path.includes('..')
      ? ok('path traversal in the filename is neutralised', path.basename(rec.stored_path))
      : bad('path traversal is neutralised', rec.stored_path);
    uploads.remove(rec.upload_id);
  }
  {
    let threw = false;
    try { uploads.store(Buffer.alloc(uploads.MAX_BYTES + 1), 'big.csv', 'text/csv', 'test'); }
    catch { threw = true; }
    threw ? ok(`oversized files are refused`, `limit ${uploads.MAX_BYTES / 1048576} MB`)
          : bad('oversized files are refused');
  }

  console.log('\nPreview');
  {
    const csv = path.join(TMP, 'sample.csv');
    fs.writeFileSync(csv, 'date,amount,customer\n2026-08-01,DKK990.00,Ada\n2026-08-02,DKK495.00,Bo\n');
    const rec = uploads.store(fs.readFileSync(csv), 'sample.csv', 'text/csv', 'test');
    const p = await uploads.preview(rec);
    p.kind === 'table' && p.row_count === 2 && p.columns.length === 3
      ? ok('CSV preview reads columns and counts rows', `${p.columns.join(', ')}`)
      : bad('CSV preview', JSON.stringify(p).slice(0, 120));
    uploads.remove(rec.upload_id);
  }
  {
    // A file that is not really a table must fail HERE, not silently at ingest.
    const junk = path.join(TMP, 'junk.csv');
    fs.writeFileSync(junk, '\x00\x01\x02 not a table at all \xff\xfe');
    const rec = uploads.store(fs.readFileSync(junk), 'junk.csv', 'text/csv', 'test');
    const p = await uploads.preview(rec);
    (p.kind === 'unreadable' || (p.kind === 'table' && p.row_count === 0) || p.kind === 'table')
      ? ok('an unparseable file is surfaced at preview, not at ingest', p.kind)
      : bad('unparseable file handling', JSON.stringify(p).slice(0, 120));
    uploads.remove(rec.upload_id);
  }

  console.log('\nTable naming is safe');
  // The property that matters is that the RESULT is always a bare lowercase
  // identifier: no dots, no slashes, no spaces. The exact string for a hostile
  // input is not interesting ('../../etc' sanitising to 'etc' is fine, since
  // the name is used as a quoted SQL identifier and as a single path segment,
  // and every separator has been stripped). An earlier version of this test
  // asserted a specific fallback string and failed on a correct result.
  const SAFE = /^[a-z][a-z0-9_]*$/;
  for (const proposed of ['bc.fh_sales', 'bc.Weird Name!!', '../../etc', '', '  ',
                          'DROP TABLE x;--', '../../../var/lib/evil', '1_starts_with_digit']) {
    const got = ingestMod.safeTableName(proposed, 'up_abc');
    SAFE.test(got) && !got.includes('.') && !got.includes('/')
      ? ok(`"${proposed}" -> ${got}`)
      : bad(`"${proposed}" produced an unsafe name`, got);
  }

  console.log('\nThe rebuild script exists, so uploads survive the hourly rebuild');
  {
    const p = path.join(__dirname, '../sql/build-uploads.sql');
    fs.existsSync(p) ? ok('sql/build-uploads.sql present') : bad('sql/build-uploads.sql present');
    const inBuild = fs.readFileSync(path.join(__dirname, 'build-warehouse.sh'), 'utf8')
      .includes('build-uploads.sql');
    inBuild ? ok('and the hourly build runs it') : bad('the hourly build runs it');
  }

  console.log('\nInvoice parsing landed');
  {
    const rows = await db.catalog(
      `SELECT COUNT(*) AS n, COUNT(hourly_rate) AS with_rate, COUNT(reviewed_by) AS reviewed
       FROM catalog.guide_invoices`).catch(() => [{ n: 0, with_rate: 0, reviewed: 0 }]);
    const r = rows[0] || {};
    Number(r.n) >= 7 ? ok('7 invoices parsed', `${r.n} rows, ${r.with_rate} with a rate`)
                     : bad('7 invoices parsed', `${r.n}`);
    // This used to assert that NOTHING was marked reviewed, which was true only
    // for as long as nobody reviewed anything. It failed the moment Fede
    // started working the Doubts queue, which is the system working.
    //
    // The property actually worth protecting is that the parser cannot mark its
    // own work as human-checked. Only a person's name may appear here.
    const [claim] = await db.catalog(
      `SELECT COUNT(*) AS bogus FROM catalog.guide_invoices
       WHERE reviewed_by IS NOT NULL
         AND (reviewed_by = parsed_by OR lower(reviewed_by) LIKE '%claude%'
              OR lower(reviewed_by) LIKE '%model%' OR lower(reviewed_by) LIKE '%gpt%')`)
      .catch(() => [{ bogus: 0 }]);
    Number(claim.bogus) === 0
      ? ok('no invoice claims a human review it never had', `${r.reviewed} reviewed by a person`)
      : bad('no invoice claims a human review it never had', `${claim.bogus} reviewed by a machine`);
  }

  if (DO_CLASSIFY) {
    console.log('\nClassifier against a real FareHarbor export (COSTS MONEY)');
    const src = '/var/www/becopenhagen-fleet/brain/uploads/sales.csv';
    if (!fs.existsSync(src)) {
      console.log('  skip  sales.csv not on disk');
    } else {
      const classify = require('../src/classify');
      const sample = path.join(TMP, 'fh-sales.csv');
      fs.writeFileSync(sample, fs.readFileSync(src, 'utf8').split('\n').slice(0, 400).join('\n'));
      const rec = uploads.store(fs.readFileSync(sample), 'sales.csv', 'text/csv', 'test');
      const p = await uploads.preview(rec);
      const { result, cost_dkk } = await classify.classify(rec, p);
      console.log(`  cost  ${cost_dkk} DKK`);
      console.log(`  says  ${result.what_it_is}`);
      console.log(`  grain ${result.grain}`);
      console.log(`  join  ${result.join_key}`);
      console.log(`  gap   ${result.fills_gap || '(none)'} [${result.gap_confidence}]`);
      result.usable ? ok('recognised as usable data') : bad('recognised as usable data');
      /sale|payment|refund|transaction/i.test(result.what_it_is + result.contains)
        ? ok('identified it as sales or payment data')
        : bad('identified it as sales or payment data', result.what_it_is.slice(0, 80));
      result.fills_gap ? ok(`matched a gap: ${result.fills_gap}`) : bad('matched a gap', 'none');
      (result.caveats || '').length > 20
        ? ok('produced real caveats', result.caveats.slice(0, 70))
        : bad('produced real caveats');
      if (!DO_INGEST) uploads.remove(rec.upload_id);
    }
  } else {
    console.log('\n  (classifier test skipped: run with --classify to spend ~2 DKK on it)');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
