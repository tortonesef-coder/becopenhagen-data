#!/usr/bin/env node
/**
 * Run the same questions through several models and print what each one
 * actually answered and actually cost.
 *
 * Fede, 2026-08-10: "I also find it expensive, 3dkk on that stupid first query
 * seems like a lot." And his standing preference, from earlier work: measure
 * models, do not assume them.
 *
 * So this does not guess that Sonnet is "probably fine". It asks all three the
 * same real questions about his real data and puts the answers side by side,
 * because the only thing that matters is whether the cheap model gets the
 * SAME ANSWER. A model that saves 80% and is wrong once a month is not cheap.
 *
 * WHAT TO LOOK AT, in order:
 *   1. did it give the same number
 *   2. did it fall into a known trap (private slots, July pax, bikes vs outings)
 *   3. cost
 *
 * Each model runs in its own process, because agent.js reads AGENT_MODEL once
 * at require time and the cached prompt prefix is per process.
 *
 *   node scripts/benchmark-models.js               # the standard 6 questions
 *   node scripts/benchmark-models.js --quick       # 3 questions
 *   node scripts/benchmark-models.js --models claude-opus-5,claude-sonnet-5
 *
 * THIS SPENDS REAL MONEY on the API key. Roughly 10 to 20 DKK for a full run.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');

const arg = f => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const MODELS = (arg('--models') || 'claude-opus-5,claude-sonnet-5,claude-haiku-4-5-20251001').split(',');
const DKK = 6.9;

// Real questions, each chosen because it has a known right answer or a known
// trap. A benchmark of questions nobody asks measures nothing.
const QUESTIONS = [
  { q: 'Which guide has worked the most hours?',
    expect: 'Monica, clearly ahead of Andrew. Should resolve Pam and Paloma to one person.' },
  { q: 'Which bike types are used most?',
    expect: 'Guided Bike far ahead. MUST NOT say we own 255 guided bikes: that is outings, we own 9.' },
  { q: 'How full are our tours?',
    expect: 'Must exclude unsold private slots, or every private product reads as 0% sold. Should mention small numbers.' },
  { q: 'How many passengers did we carry in July?',
    expect: 'Must REFUSE or flag it. July pax reads as zero and is wrong: the departure rows were deleted from the fleet DB.' },
  { q: 'Revenue by channel?',
    expect: 'Gross of commission. Should say so, and that commission rates are estimates.' },
  { q: 'How many bikes are out on 15 August?',
    expect: 'Should include rentals, not just tours, and compare against fleet size.' },
];

const asked = process.argv.includes('--quick') ? QUESTIONS.slice(0, 3) : QUESTIONS;

// The child. Kept inline so there is no second file to keep in step with this one.
const RUNNER = `
const agent = require(${JSON.stringify(path.join(__dirname, '../src/agent.js'))});
const context = require(${JSON.stringify(path.join(__dirname, '../src/context.js'))});
(async () => {
  await context.build();
  const out = [];
  for (const q of JSON.parse(process.env.BENCH_QUESTIONS)) {
    const started = Date.now();
    try {
      const r = await agent.ask({ question: q, username: 'benchmark', history: [] }, () => {});
      out.push({ q, answer: r.answer, meta: r.meta, ms: Date.now() - started });
    } catch (e) {
      out.push({ q, error: e.message, ms: Date.now() - started });
    }
  }
  process.stdout.write('@@BENCH@@' + JSON.stringify(out));
})().catch(e => { process.stderr.write(e.stack); process.exit(1); });
`;

(async () => {
  console.log(`Asking ${asked.length} question(s) of ${MODELS.length} model(s). This spends real money.\n`);
  const results = {};

  for (const model of MODELS) {
    process.stdout.write(`${model} ... `);
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(process.execPath, ['-e', RUNNER], {
        env: { ...process.env, AGENT_MODEL: model, BENCH_NO_BUDGET: '1', BENCH_QUESTIONS: JSON.stringify(asked.map(a => a.q)) },
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000,
      });
      const marker = stdout.indexOf('@@BENCH@@');
      results[model] = JSON.parse(stdout.slice(marker + 9));
      const cost = results[model].reduce((a, r) => a + (r.meta?.cost_usd || 0), 0) * DKK;
      console.log(`done in ${Math.round((Date.now() - started) / 1000)}s, ${cost.toFixed(2)} DKK`);
    } catch (e) {
      console.log(`FAILED: ${String(e.stderr || e.message).slice(0, 200)}`);
      results[model] = null;
    }
  }

  // ── The table ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log(' COST');
  console.log('='.repeat(70));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('model', 30) + pad('total DKK', 12) + pad('per question', 14) + 'avg seconds');
  for (const m of MODELS) {
    const rs = results[m];
    if (!rs) { console.log(pad(m, 30) + 'failed'); continue; }
    const dkk = rs.reduce((a, r) => a + (r.meta?.cost_usd || 0), 0) * DKK;
    const secs = rs.reduce((a, r) => a + r.ms, 0) / rs.length / 1000;
    console.log(pad(m, 30) + pad(dkk.toFixed(2), 12) + pad((dkk / rs.length).toFixed(2), 14) + secs.toFixed(0));
  }

  console.log('\n' + '='.repeat(70));
  console.log(' THE ANSWERS. Cost is the last thing to look at, not the first.');
  console.log('='.repeat(70));
  asked.forEach((item, i) => {
    console.log(`\n\n### ${item.q}`);
    console.log(`WHAT A GOOD ANSWER DOES: ${item.expect}\n`);
    for (const m of MODELS) {
      const r = results[m]?.[i];
      if (!r) { console.log(`--- ${m}: no result\n`); continue; }
      const dkk = ((r.meta?.cost_usd || 0) * DKK).toFixed(2);
      console.log(`--- ${m}  (${dkk} DKK, ${Math.round(r.ms / 1000)}s)`);
      console.log(r.error ? `ERROR: ${r.error}` : String(r.answer).trim());
      console.log('');
    }
  });

  console.log('\nRead the answers before the prices. A model that saves 80% and is');
  console.log('wrong once a month is not cheap, it is a liability with a discount.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
