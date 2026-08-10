// The agent: one question in, one grounded answer out.
//
// Streams to the browser over SSE so an answer that takes twenty seconds does
// not look like a hang.

const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const context = require('./context');
const tools = require('./tools');
const usage = require('./usage');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
// 12000, not 8000. On claude-opus-5 THINKING IS ON BY DEFAULT and max_tokens is
// a hard cap on thinking PLUS the visible answer, so a budget sized around the
// answer alone truncates mid-sentence. Verified against the model reference on
// 2026-08-10; the earlier 8000 was carried over from an older model's behaviour.
const MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 12000);
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 12);

// Verified against the claude-opus-5 model reference, 2026-08-10. Per million
// tokens: $5 in, $25 out, cache read is 0.1x input. Cache WRITE depends on the
// TTL: 1.25x input at 5 minutes, 2x at 1 hour. This app uses the 1 hour TTL,
// argued at the cache_control call site below. Thinking tokens bill as output.
//
// These drive the DKK budget below, so they are load-bearing rather than
// decorative. Re-check them when the model changes.
// Per million tokens, in USD. Cache write is 1.25x input at the 5 minute TTL
// and 2x at one hour; cache read is 0.1x input. Those multipliers are the same
// for every model, so only in/out are listed and the rest is derived. Getting
// this wrong does not break an answer, it silently misreports what the tool
// costs, which is worse: nobody notices a wrong number they were not checking.
const PRICING = {
  'claude-opus-5':          { in: 5 / 1e6,    out: 25 / 1e6 },
  'claude-sonnet-5':        { in: 3 / 1e6,    out: 15 / 1e6 },
  'claude-haiku-4-5-20251001': { in: 1 / 1e6, out: 5 / 1e6 },
};

function priceFor(model) {
  const p = PRICING[model] || PRICING['claude-opus-5'];
  return {
    in: p.in, out: p.out,
    cacheRead: p.in * 0.1,
    cacheWrite5m: p.in * 1.25,
    cacheWrite1h: p.in * 2,
  };
}

const PRICE = priceFor(MODEL);

// Adaptive thinking and output_config.effort are Claude 5 features. Haiku 4.5
// returns a 400 for both, so they are omitted rather than sent and caught.
const SUPPORTS_ADAPTIVE_THINKING = /^claude-(opus|sonnet|fable)-5/.test(MODEL);

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // pm2 does not inherit /etc/environment, which is where the fleet app keeps
  // the shared key. Read it the same way bc-fleet's server.js does.
  try {
    const m = fs.readFileSync('/etc/environment', 'utf8')
      .match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return null;
}

/** Volatile facts. Deliberately NOT in the cached prefix: they change hourly. */
async function freshness() {
  const [f] = await db.warehouse(`SELECT * FROM bc.data_freshness`);
  if (!f) return { text: 'Freshness unknown.', loaded_at: null, stale: true };
  const loaded = new Date(String(f.loaded_at).replace(' ', 'T') + 'Z');
  const ageMin = Math.round((Date.now() - loaded.getTime()) / 60000);
  const stale = ageMin > 180;
  return {
    loaded_at: f.loaded_at, age_minutes: ageMin, stale,
    departures: f.departures, bookings: f.bookings,
    earliest: f.earliest_departure, latest: f.latest_departure,
    text: `# Right now\n\nData as of ${f.loaded_at} UTC (${ageMin} minutes ago${stale ? ', STALE, say so' : ''}).\n` +
          `The warehouse holds ${f.departures} departures and ${f.bookings} bookings, ` +
          `covering ${f.earliest_departure} to ${f.latest_departure}.\n` +
          `Today is ${new Date().toISOString().slice(0, 10)}.`,
  };
}

/**
 * The per-question spending limit, in DKK.
 *
 * Fede, 2026-08-10: "it'd be nice if each query had a budget limit (say 3 DKK),
 * and if it reaches or estimates it will reach it asks if it's worth spending
 * up to 10 DKK?"
 *
 * Read from catalog.settings on every question rather than baked in, so the
 * numbers and the exchange rate can be changed without a deploy.
 *
 * The check runs BETWEEN turns, and projects one turn ahead: stopping only once
 * the limit is already blown would routinely overshoot, because a single turn
 * that re-sends a long conversation plus tool results is the expensive unit.
 */
async function budgetSettings() {
  const rows = await db.catalog(
    `SELECT key, value FROM catalog.settings
     WHERE key IN ('query_budget_dkk','query_budget_max_dkk','usd_to_dkk','agent_effort','cache_ttl')`);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // The benchmark has to let every question run to completion or the models are
  // not being compared on the same work: a run that paused at 3 DKK and one that
  // finished are two different answers to two different questions.
  if (process.env.BENCH_NO_BUDGET === '1') {
    return { soft: 1e9, hard: 1e9, rate: Number(s.usd_to_dkk ?? 6.9),
             effort: s.agent_effort || 'high', cacheTtl: s.cache_ttl === '5m' ? '5m' : '1h' };
  }
  return {
    soft: Number(s.query_budget_dkk ?? 3),
    hard: Number(s.query_budget_max_dkk ?? 10),
    rate: Number(s.usd_to_dkk ?? 6.9),
    effort: s.agent_effort || 'high',
    cacheTtl: s.cache_ttl === '5m' ? '5m' : '1h',
  };
}

// Sessions paused on the budget, waiting for a yes or no. In memory on purpose:
// two users, ad hoc use, and a pending question that does not survive a restart
// is the correct outcome (the user just asks again). Entries expire so an
// abandoned prompt cannot pin a large conversation in memory forever.
const pending = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000;

function reapPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [token, entry] of pending) if (entry.at < cutoff) pending.delete(token);
}

async function callApi(key, messages, system, effort) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking is on by default on the Claude 5 models; stated explicitly so
      // the behaviour is visible in the code rather than implied. display stays
      // omitted (the default): the reasoning is not shown to the user, and
      // asking for a summary would cost tokens nobody reads.
      //
      // Haiku 4.5 rejects it outright ("adaptive thinking is not supported on
      // this model"), which is a 400 on every single call, so a model that does
      // not support it must not be sent it. Found by benchmarking: the Haiku run
      // failed all three questions in one second flat.
      ...(SUPPORTS_ADAPTIVE_THINKING ? { thinking: { type: 'adaptive' } } : {}),
      ...(SUPPORTS_ADAPTIVE_THINKING ? { output_config: { effort } } : {}),
      system, messages, tools: tools.DEFINITIONS,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
    err.status = res.status;
    // The one failure mode worth naming precisely, because it has already
    // happened once on this project and the generic message is baffling.
    if (/credit balance is too low/i.test(body)) {
      err.friendly = 'The Anthropic API account has no credit left, so I cannot answer. Top it up and try again.';
    }
    throw err;
  }
  return res.json();
}

/**
 * Answers one question.
 * @param {function} emit  (event, data) => void, for streaming to the browser.
 */
async function ask({ question, username, history = [], resume = null }, emit = () => {}) {
  const key = apiKey();
  if (!key) throw new Error('No ANTHROPIC_API_KEY available.');

  const budget = await budgetSettings();

  // Resuming an approved over-budget question: pick the conversation back up
  // exactly where it paused rather than paying to redo the work already done.
  if (resume) {
    reapPending();
    const saved = pending.get(resume);
    if (!saved) {
      throw Object.assign(new Error('That question expired.'),
        { friendly: 'That question timed out waiting for an answer. Ask it again.' });
    }
    if (saved.username !== username) throw new Error('Not your question.');
    pending.delete(resume);
    return runLoop({ ...saved, key, budget, ceiling: budget.hard, username }, emit);
  }

  const started = Date.now();
  const fresh = await freshness();

  // The cached prefix. Order matters: the large invariant block first, then the
  // small volatile one, so the cache breakpoint sits after the invariant part.
  //
  // ONE HOUR TTL, NOT THE 5 MINUTE DEFAULT, and the reason is this app's actual
  // usage pattern. The spec describes it as "idle for a week and then ten
  // questions in an afternoon", and between two of those questions a person
  // reads the answer and thinks, which takes more than five minutes. With the
  // default TTL the ~17k token context block expires between almost every pair
  // of questions, so nearly every question pays the cache WRITE premium
  // (1.25x input) instead of the read price (0.1x).
  //
  // The 1 hour TTL costs more to write (2x rather than 1.25x) but survives
  // those gaps. Measured on the real context block: ten questions in an
  // afternoon cost about 7.3 DKK in cache charges at 5 minutes versus about
  // 1.7 DKK at 1 hour. It is only worse for a single isolated question that is
  // never followed up, which is not how this tool gets used.
  const system = [
    { type: 'text', text: context.get(),
      cache_control: { type: 'ephemeral', ttl: budget.cacheTtl } },
    { type: 'text', text: fresh.text },
  ];

  const messages = [
    ...history.flatMap(h => ([
      { role: 'user', content: h.question },
      { role: 'assistant', content: h.answer },
    ])),
    { role: 'user', content: question },
  ];

  // question is carried so flag_doubt can record WHICH question forced the
  // assumption. A doubt without the question that produced it is just another
  // orphaned card, which is what the pre-generated queue was.
  const ctx = { sqlRun: [], assertionsFired: [], gapCited: null, canonicalUsed: null,
                contributions: [], question, doubtRaised: false };
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  return runLoop({
    key, budget, ceiling: budget.soft, username, question, started, fresh,
    system, messages, ctx, usage, answer: '', turn: 0,
  }, emit);
}

function costOf(usage, ttl = '1h') {
  const write = ttl === '5m' ? PRICE.cacheWrite5m : PRICE.cacheWrite1h;
  return usage.input * PRICE.in + usage.output * PRICE.out +
         usage.cacheWrite * write + usage.cacheRead * PRICE.cacheRead;
}

/**
 * The agent turn loop, extracted so a budget pause can suspend it and a later
 * approval can resume from exactly the same state.
 *
 * `ceiling` is the limit for THIS run: the soft budget on a fresh question, the
 * hard maximum once the user has approved going further. The hard maximum is
 * never negotiable, so an approved question still stops rather than running away.
 */
async function runLoop(state, emit = () => {}) {
  const { key, budget, ceiling, username, question, started, fresh, system, messages, ctx, usage } = state;

  for (let turn = state.turn; turn < MAX_TURNS; turn++) {
    // Project one turn ahead using the average cost of the turns so far. The
    // expensive unit is a whole turn (it re-sends the conversation plus every
    // tool result), so stopping only after the limit is already blown would
    // routinely overshoot by a turn.
    const spentDkk = costOf(usage, budget.cacheTtl) * budget.rate;
    const perTurn  = turn > 0 ? spentDkk / turn : 0;
    const projected = spentDkk + perTurn;

    if (turn > 0 && (spentDkk >= ceiling || projected > ceiling)) {
      if (ceiling >= budget.hard) {
        // The hard maximum. Stop and answer with what we have rather than
        // asking again: the user already said yes once.
        state.answer += (state.answer ? '\n\n' : '') +
          `I stopped here because this question reached the ${budget.hard} DKK maximum. ` +
          `What I found before stopping is above; ask a narrower question to go further.`;
        emit('text', { text: '\n\n(Stopped at the maximum spend for one question.)' });
        break;
      }
      // Soft budget: park the conversation and ask.
      reapPending();
      const token = crypto.randomUUID();
      pending.set(token, { ...state, turn, at: Date.now() });
      emit('budget', {
        resume_token: token,
        spent_dkk: Number(spentDkk.toFixed(2)),
        projected_dkk: Number(projected.toFixed(2)),
        budget_dkk: ceiling,
        max_dkk: budget.hard,
        partial_answer: state.answer || null,
      });
      return { answer: state.answer, meta: { paused: true, spent_dkk: Number(spentDkk.toFixed(2)) } };
    }

    const body = await callApi(key, messages, system, budget.effort);

    usage.input      += body.usage?.input_tokens || 0;
    usage.output     += body.usage?.output_tokens || 0;
    usage.cacheWrite += body.usage?.cache_creation_input_tokens || 0;
    usage.cacheRead  += body.usage?.cache_read_input_tokens || 0;

    const textBlocks = (body.content || []).filter(b => b.type === 'text');
    const toolUses   = (body.content || []).filter(b => b.type === 'tool_use');

    for (const t of textBlocks) {
      if (t.text) { state.answer += (state.answer ? '\n\n' : '') + t.text; emit('text', { text: t.text }); }
    }

    if (!toolUses.length) break;

    messages.push({ role: 'assistant', content: body.content });
    const results = [];
    for (const use of toolUses) {
      emit('tool', { name: use.name, input: use.input });
      if (use.name === 'find_canonical_query') ctx.canonicalUsed = ctx.canonicalUsed || 'searched';
      let result;
      try {
        result = await tools.execute(use.name, use.input || {}, ctx);
      } catch (e) {
        result = { error: e.message };
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  const answer = state.answer;
  const cost = costOf(usage, budget.cacheTtl);

  const blocking = ctx.assertionsFired.filter(a => a.severity === 'block');
  const meta = {
    sql: ctx.sqlRun,
    assertions: ctx.assertionsFired,
    blocked: blocking.length > 0,
    gap_cited: ctx.gapCited,
    freshness: { loaded_at: fresh.loaded_at, age_minutes: fresh.age_minutes, stale: fresh.stale },
    usage,
    cost_usd: Number(cost.toFixed(4)),
    // DKK is what Fede thinks in, so it is what the UI shows.
    cost_dkk: Number((cost * budget.rate).toFixed(2)),
    budget_dkk: budget.soft,
    model: MODEL,
    latency_ms: Date.now() - started,
    // Cache hit rate, so the spec's "caching is architectural" claim stays
    // honest rather than assumed. Should be high from the second question on.
    cache_hit_ratio: usage.cacheRead + usage.cacheWrite > 0
      ? Number((usage.cacheRead / (usage.cacheRead + usage.cacheWrite)).toFixed(2)) : 0,
  };

  let queryLogId = null;
  try {
    queryLogId = await db.logQuery({
      asked_at: null, username, question,
      sql_run: ctx.sqlRun.map(s => s.sql).join(';\n\n') || null,
      result_summary: answer.slice(0, 4000),
      row_count: ctx.sqlRun.reduce((a, s) => a + (s.rowCount || 0), 0),
      assertions_fired: ctx.assertionsFired.map(a => `${a.severity}:${a.key}`).join(',') || null,
      gap_cited: ctx.gapCited, canonical_query_key: ctx.canonicalUsed,
      latency_ms: meta.latency_ms,
      input_tokens: usage.input, output_tokens: usage.output,
      cached_tokens: usage.cacheRead, cost_usd: meta.cost_usd, model: MODEL, error: null,
    });
  } catch (e) {
    console.error('[agent] could not write the query log:', e.message);
  }
  meta.query_log_id = queryLogId;

  // Which sources actually earned their place. Everything queried is recorded
  // as referenced; the agent's own report upgrades the ones that carried the
  // answer. Never allowed to break an answer that already succeeded.
  try {
    await usage.record({
      queryLogId, username,
      sqlRun: ctx.sqlRun,
      contributions: ctx.contributions,
    });
  } catch (e) {
    console.error('[agent] could not record source usage:', e.message);
  }

  emit('done', meta);
  return { answer, meta };
}

module.exports = { ask, freshness, MODEL };
