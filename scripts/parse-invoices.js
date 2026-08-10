#!/usr/bin/env node
/**
 * Reads the guide invoice PDFs already uploaded to bc-fleet and extracts what
 * each guide charged, so cost per tour becomes answerable.
 *
 * Fede, 2026-08-10: "in theory all guides uploaded their invoice so it has the
 * rate per guide". Verified: 7 PDFs covering 5 of 8 active guides across 3
 * billing periods, sitting on disk. Only the filename was in the database.
 *
 * READ ONLY against bc-fleet. It opens the fleet database with mode=ro and only
 * ever reads the PDF files. It writes nothing there, ever.
 *
 * Claude reads the PDFs natively as document blocks. No local PDF library, and
 * the model sees the layout, which matters because these are seven different
 * formats: one Word export, one in German, one with hours as a table and one
 * with a single line total.
 *
 *   node scripts/parse-invoices.js [--dry-run] [--force]
 *
 * Costs about 1 to 2 DKK per invoice against the API key (runtime feature, per
 * the cost policy). Already-parsed invoices are skipped unless --force.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../src/db');

const FLEET_DB = process.env.FLEET_DB_PATH || '/var/www/becopenhagen-fleet/data/fleet.db';
const INVOICE_DIR = path.join(path.dirname(FLEET_DB), 'invoices');
const DUCKDB = '/usr/local/bin/duckdb';
const MODEL = process.env.CLASSIFY_MODEL || 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const PRICE = { in: 5 / 1e6, out: 25 / 1e6 };

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const m = fs.readFileSync('/etc/environment', 'utf8')
    .match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
  return m ? m[1].trim() : null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    total_amount: { type: ['number', 'null'], description: 'The total amount invoiced, as a number with no currency symbol or thousands separator.' },
    currency: { type: ['string', 'null'], description: 'DKK, EUR, etc. Null if not stated.' },
    hours_claimed: { type: ['number', 'null'], description: 'Total hours claimed on the invoice, if stated. Null if the invoice does not break out hours.' },
    hourly_rate: { type: ['number', 'null'], description: 'The rate per hour if stated OR derivable from total divided by hours. Null if neither.' },
    rate_is_derived: { type: 'boolean', description: 'True if you calculated the rate rather than reading it off the invoice.' },
    period_start: { type: ['string', 'null'], description: 'Start of the billing period as YYYY-MM-DD. Null if not stated.' },
    period_end: { type: ['string', 'null'], description: 'End of the billing period as YYYY-MM-DD. Null if not stated.' },
    line_items: { type: 'array', description: 'Each billed line, if the invoice itemises them.',
      items: { type: 'object',
        properties: { description: { type: 'string' }, quantity: { type: ['number', 'null'] }, amount: { type: ['number', 'null'] } },
        required: ['description', 'quantity', 'amount'], additionalProperties: false } },
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low if the document is hard to read or the figures are ambiguous.' },
    notes: { type: 'string', description: 'Anything a person should check. Empty string if nothing.' },
  },
  required: ['total_amount', 'currency', 'hours_claimed', 'hourly_rate', 'rate_is_derived',
             'period_start', 'period_end', 'line_items', 'invoice_number', 'invoice_date',
             'confidence', 'notes'],
  additionalProperties: false,
};

const INSTRUCTIONS = `
You are reading a freelance guide's invoice to BeCopenhagen, a Copenhagen bike
tour company. Extract the figures exactly as they appear.

Rules:
- Read the numbers off the document. Do not estimate, and do not infer a total
  that is not written down.
- hourly_rate: read it if the invoice states it. If the invoice gives a total
  and hours but no rate, compute it and set rate_is_derived to true. If neither
  is available, null.
- Amounts are numbers only: 4500.50, never "DKK 4.500,50". Watch for European
  formatting where the comma is the decimal separator.
- Dates as YYYY-MM-DD. Danish invoices often use dd-mm-yyyy; do not swap day
  and month.
- confidence "low" if the scan is poor, the figures are ambiguous, or the
  document is not actually an invoice.
- notes: anything a person should check by eye. Be specific.

Some of these invoices are in German or Italian. Read them anyway.
`.trim();

async function parseOne(guideId, filePath) {
  const key = apiKey();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000,
      system: INSTRUCTIONS,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf',
                                      data: fs.readFileSync(filePath).toString('base64') } },
        { type: 'text', text: `This invoice was uploaded by the guide with id "${guideId}". File name: "${path.basename(filePath)}".` },
      ] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (/credit balance is too low/i.test(body)) throw new Error('No API credit left.');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const usage = body.usage || {};
  return {
    data: JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()),
    cost_usd: (usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out,
  };
}

const q = s => (s === null || s === undefined) ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
const n = v => (v === null || v === undefined || Number.isNaN(Number(v))) ? 'NULL' : Number(v);

(async () => {
  if (!apiKey()) { console.error('No ANTHROPIC_API_KEY.'); process.exit(1); }

  // The invoice metadata rows, read-only from the fleet database.
  const meta = JSON.parse(execFileSync(DUCKDB, ['-json', '-c', `
    INSTALL sqlite; LOAD sqlite;
    ATTACH '${FLEET_DB}' AS f (TYPE SQLITE, READ_ONLY);
    SELECT id, guide_id, original_filename, stored_filename, period_label, uploaded_at
    FROM f.guide_invoices ORDER BY uploaded_at;`], { encoding: 'utf8' }).trim() || '[]');

  console.log(`${meta.length} invoice record(s) in bc-fleet.\n`);

  await db.catalogWrite(`
    CREATE TABLE IF NOT EXISTS catalog.guide_invoices (
      invoice_id      INTEGER PRIMARY KEY,   -- fleet guide_invoices.id
      guide_id        VARCHAR,
      original_name   VARCHAR,
      period_label    VARCHAR,
      period_start    DATE,
      period_end      DATE,
      invoice_number  VARCHAR,
      invoice_date    DATE,
      total_amount    DOUBLE,
      currency        VARCHAR,
      hours_claimed   DOUBLE,
      hourly_rate     DOUBLE,
      rate_is_derived BOOLEAN,
      line_items      JSON,
      confidence      VARCHAR,
      notes           TEXT,
      parsed_by       VARCHAR,
      parsed_at       TIMESTAMP,
      reviewed_by     VARCHAR,   -- NOBODY until a person checks it
      reviewed_at     TIMESTAMP
    );`);

  const done = new Set((await db.catalog(
    `SELECT invoice_id FROM catalog.guide_invoices`)).map(r => Number(r.invoice_id)));

  let totalCost = 0, parsed = 0, failed = 0;

  for (const inv of meta) {
    const id = Number(inv.id);
    if (done.has(id) && !FORCE) { console.log(`  skip  #${id} ${inv.guide_id} (already parsed)`); continue; }

    const filePath = path.join(INVOICE_DIR, inv.guide_id, inv.stored_filename);
    if (!fs.existsSync(filePath)) {
      console.log(`  MISS  #${id} ${inv.guide_id}: file not on disk (${inv.stored_filename})`);
      failed++; continue;
    }

    try {
      const { data, cost_usd } = await parseOne(inv.guide_id, filePath);
      totalCost += cost_usd;
      const rate = data.hourly_rate;
      console.log(`  ok    #${id} ${inv.guide_id.padEnd(9)} ` +
        `${String(data.total_amount ?? '?').padStart(9)} ${data.currency || ''}  ` +
        `${data.hours_claimed != null ? data.hours_claimed + 'h' : 'no hours'}  ` +
        `${rate != null ? rate + '/h' + (data.rate_is_derived ? ' (derived)' : '') : 'no rate'}  ` +
        `[${data.confidence}]${data.notes ? '  ' + data.notes.slice(0, 60) : ''}`);

      if (!DRY) {
        await db.catalogWrite(`
          INSERT OR REPLACE INTO catalog.guide_invoices
            (invoice_id, guide_id, original_name, period_label, period_start, period_end,
             invoice_number, invoice_date, total_amount, currency, hours_claimed,
             hourly_rate, rate_is_derived, line_items, confidence, notes, parsed_by,
             parsed_at, reviewed_by, reviewed_at)
          VALUES (${id}, ${q(inv.guide_id)}, ${q(inv.original_filename)}, ${q(inv.period_label)},
                  ${data.period_start ? `DATE ${q(data.period_start)}` : 'NULL'},
                  ${data.period_end ? `DATE ${q(data.period_end)}` : 'NULL'},
                  ${q(data.invoice_number)},
                  ${data.invoice_date ? `DATE ${q(data.invoice_date)}` : 'NULL'},
                  ${n(data.total_amount)}, ${q(data.currency)}, ${n(data.hours_claimed)},
                  ${n(data.hourly_rate)}, ${data.rate_is_derived ? 'TRUE' : 'FALSE'},
                  ${q(JSON.stringify(data.line_items || []))}, ${q(data.confidence)},
                  ${q(data.notes)}, ${q(MODEL)}, now(), NULL, NULL);`);
      }
      parsed++;
    } catch (e) {
      console.log(`  FAIL  #${id} ${inv.guide_id}: ${e.message}`);
      failed++;
      if (/No API credit/.test(e.message)) break;
    }
  }

  const [{ value: rate } = {}] = await db.catalog(
    `SELECT value FROM catalog.settings WHERE key = 'usd_to_dkk'`);
  console.log(`\n${parsed} parsed, ${failed} failed. Cost ${(totalCost * Number(rate || 6.9)).toFixed(2)} DKK.`);
  if (DRY) { console.log('Dry run: nothing written.'); return; }

  const low = await db.catalog(
    `SELECT guide_id, original_name, confidence, notes FROM catalog.guide_invoices
     WHERE confidence <> 'high' OR reviewed_by IS NULL ORDER BY confidence, guide_id`);
  if (low.length) {
    console.log(`\n${low.length} invoice(s) need a human eye before the figures are trusted:`);
    for (const r of low) {
      console.log(`  ${r.guide_id.padEnd(9)} [${r.confidence}] ${r.original_name}`);
      if (r.notes) console.log(`            ${r.notes}`);
    }
  }
  console.log('\nEvery row is parsed_by a model and reviewed_by NOBODY. Treat the');
  console.log('figures as a draft until somebody checks them against the PDFs.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
