// The agent: one question in, one grounded answer out.
//
// Streams to the browser over SSE so an answer that takes twenty seconds does
// not look like a hang.

const fs = require('fs');
const db = require('./db');
const context = require('./context');
const tools = require('./tools');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
const MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 8000);
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 12);

// Rough Opus rates, only so cost is visible from week one (spec section 9).
// Not billing-accurate; the real figure is on the Anthropic console.
const PRICE = { in: 5 / 1e6, out: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 };

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

async function callApi(key, messages, system) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools: tools.DEFINITIONS }),
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
async function ask({ question, username, history = [] }, emit = () => {}) {
  const key = apiKey();
  if (!key) throw new Error('No ANTHROPIC_API_KEY available.');

  const started = Date.now();
  const fresh = await freshness();

  // The cached prefix. Order matters: the large invariant block first, then the
  // small volatile one, so the cache breakpoint sits after the invariant part.
  const system = [
    { type: 'text', text: context.get(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: fresh.text },
  ];

  const messages = [
    ...history.flatMap(h => ([
      { role: 'user', content: h.question },
      { role: 'assistant', content: h.answer },
    ])),
    { role: 'user', content: question },
  ];

  const ctx = { sqlRun: [], assertionsFired: [], gapCited: null, canonicalUsed: null };
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let answer = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = await callApi(key, messages, system);

    usage.input      += body.usage?.input_tokens || 0;
    usage.output     += body.usage?.output_tokens || 0;
    usage.cacheWrite += body.usage?.cache_creation_input_tokens || 0;
    usage.cacheRead  += body.usage?.cache_read_input_tokens || 0;

    const textBlocks = (body.content || []).filter(b => b.type === 'text');
    const toolUses   = (body.content || []).filter(b => b.type === 'tool_use');

    for (const t of textBlocks) {
      if (t.text) { answer += (answer ? '\n\n' : '') + t.text; emit('text', { text: t.text }); }
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

  const cost =
    usage.input * PRICE.in + usage.output * PRICE.out +
    usage.cacheWrite * PRICE.cacheWrite + usage.cacheRead * PRICE.cacheRead;

  const blocking = ctx.assertionsFired.filter(a => a.severity === 'block');
  const meta = {
    sql: ctx.sqlRun,
    assertions: ctx.assertionsFired,
    blocked: blocking.length > 0,
    gap_cited: ctx.gapCited,
    freshness: { loaded_at: fresh.loaded_at, age_minutes: fresh.age_minutes, stale: fresh.stale },
    usage, cost_usd: Number(cost.toFixed(4)), model: MODEL,
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

  emit('done', meta);
  return { answer, meta };
}

module.exports = { ask, freshness, MODEL };
