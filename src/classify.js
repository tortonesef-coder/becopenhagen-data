// Asking a model what an uploaded file is, and whether it fills a known gap.
//
// The classifier PROPOSES. It never ingests, never registers a source and never
// flips a gap. Everything it returns is shown to a person first. That split is
// the whole safety story here: reading a header row is a good guess, and a good
// guess written silently into catalog.sources would be believed by every answer
// afterwards.
//
// Runtime feature, so it bills to the API key, per Fede's cost policy
// (2026-08-10). One classification is roughly 1 to 3 DKK depending on file type;
// a PDF costs more than a CSV preview because the whole document goes over.

const fs = require('fs');
const db = require('./db');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLASSIFY_MODEL || process.env.AGENT_MODEL || 'claude-opus-5';
const PRICE = { in: 5 / 1e6, out: 25 / 1e6 };

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const m = fs.readFileSync('/etc/environment', 'utf8')
      .match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return null;
}

/** The result shape, enforced by the API rather than hoped for. */
const SCHEMA = {
  type: 'object',
  properties: {
    what_it_is: { type: 'string', description: 'One or two plain sentences. What is this file, for a non-technical business owner.' },
    proposed_name: { type: 'string', description: 'Short human label, e.g. "FareHarbor sales report".' },
    proposed_key: { type: 'string', description: 'A bc.* table name in snake_case, e.g. bc.fh_sales.' },
    contains: { type: 'string', description: 'What is actually in it, in business terms.' },
    grain: { type: 'string', description: 'What ONE ROW represents, e.g. "one payment or refund event".' },
    join_key: { type: 'string', description: 'How it would connect to the existing bc.* tables, naming the exact columns. If it cannot be joined, the literal string "none: comparison only".' },
    fills_gap: { type: ['string', 'null'], description: 'The gap_key it fills, exactly as listed. null if none match.' },
    gap_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    gap_reasoning: { type: 'string', description: 'One sentence on why that gap, or why none.' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', description: 'date, number, text, money, boolean' },
          description: { type: 'string' },
          is_pii: { type: 'boolean' },
        },
        required: ['name', 'type', 'description', 'is_pii'],
        additionalProperties: false,
      },
    },
    caveats: { type: 'string', description: 'What would go wrong if someone used this naively. Be concrete and specific to THIS file. Empty string if genuinely none.' },
    usable: { type: 'boolean', description: 'False if the file is unreadable, empty, or clearly not business data.' },
  },
  required: ['what_it_is', 'proposed_name', 'proposed_key', 'contains', 'grain',
             'join_key', 'fills_gap', 'gap_confidence', 'gap_reasoning', 'columns', 'caveats', 'usable'],
  additionalProperties: false,
};

/** What the model needs to know to place a file in THIS business. */
async function contextForClassifier() {
  const gaps = await db.catalog(`
    SELECT gap_key, category, missing, contains, grain, join_key, status
    FROM catalog.gaps WHERE status IN ('gap', 'partial', 'investigating')
    ORDER BY category, gap_key`);
  const sources = await db.catalog(
    `SELECT source_key, description, grain FROM catalog.sources ORDER BY source_key`);

  let out = `# BeCopenhagen

Guided bike tours and bike rentals in Copenhagen. Currency DKK. Tour codes: A3
architecture, L3 liveability, F3 food, H3 history, with A3G German and A3F
French; private versions carry a P suffix (A3P, L3P, F3P, H3P, L2P) and CUSTOM
is bespoke. Rentals are 1-D to 14-D, the number being days. Channels: direct,
GetYourGuide, Viator, Airbnb, TripAdvisor. Guides: Federico, Hassan, Paloma,
Feidhlim, Ibrahim, Monica, Andrew, Dimitra.

# What the warehouse ALREADY has

Do not propose a gap for something already here. If the file duplicates one of
these, say so in caveats.
`;
  for (const s of sources) {
    out += `\n- ${s.source_key}: ${String(s.description || '').replace(/\s+/g, ' ')} (one row = ${String(s.grain || '?').replace(/\s+/g, ' ')})`;
  }

  out += `\n\n# Known gaps this file might fill

Match ONLY if the file genuinely contains what the gap describes. A partial
match is a "low" confidence, not a "high" one. If nothing fits, return null:
a wrong match is worse than no match, because it would mark a gap as solved.
`;
  for (const g of gaps) {
    out += `\n## ${g.gap_key} (${g.category}, currently ${g.status})\n`;
    out += `MISSING: ${String(g.missing).replace(/\s+/g, ' ')}\n`;
    if (g.contains) out += `WOULD CONTAIN: ${String(g.contains).replace(/\s+/g, ' ')}\n`;
    out += `EXPECTED GRAIN: ${String(g.grain || '?').replace(/\s+/g, ' ')}\n`;
  }
  return out;
}

const INSTRUCTIONS = `
You are cataloguing a file somebody just uploaded to a business data tool.

Work out what it is, what is in it, and whether it fills one of the known gaps.

Rules:
- Ground everything in what you can actually SEE in the file. Do not assume a
  column exists because the name suggests it should.
- grain is what ONE ROW represents. Get this right; it decides which questions
  the data can answer.
- join_key must name real columns. If the file has no column that could connect
  it to the existing tables, return the literal string "none: comparison only".
- fills_gap: null unless the file genuinely contains what the gap describes.
  A wrong match marks a gap as solved when it is not, which is worse than no
  match at all. Partial overlap is "low" confidence.
- is_pii: true for anything identifying a person. Names, emails, phone numbers,
  addresses. Staff names count.
- caveats: what would go wrong if somebody used this naively. Be specific to
  this file: a date column that is really text, money with a currency prefix, a
  title row above the header, a total row at the bottom that would double every
  sum. Empty string only if there is genuinely nothing.
- usable: false if it is unreadable, empty, or not business data.

House style: no em dashes or en dashes as punctuation. Plain English.
`.trim();

/**
 * Classify one uploaded file.
 * @returns {{result: object, cost_dkk: number, model: string}}
 */
async function classify(record, previewData, { rateDkk = 6.9 } = {}) {
  const key = apiKey();
  if (!key) throw new Error('No ANTHROPIC_API_KEY available.');

  const context = await contextForClassifier();
  const content = [];

  if (previewData.kind === 'pdf') {
    // Claude reads the PDF natively, layout included. Better than any local
    // text dump, and one dependency fewer.
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: previewData.base64 },
    });
    content.push({ type: 'text', text: `The file is named "${record.original_name}".` });
  } else if (previewData.kind === 'table') {
    content.push({ type: 'text', text:
      `File: "${record.original_name}" (${record.file_kind}, ${previewData.row_count} rows).\n` +
      `NOTE: ${previewData.note}\n\n` +
      `Parsed columns: ${JSON.stringify(previewData.columns)}\n\n` +
      `First ${previewData.rows.length} rows:\n${JSON.stringify(previewData.rows, null, 1).slice(0, 24000)}` });
  } else if (previewData.kind === 'text') {
    content.push({ type: 'text', text:
      `File: "${record.original_name}" (${record.file_kind}).\n\nFirst part of the file:\n${previewData.text}` });
  } else if (previewData.kind === 'unreadable') {
    return {
      result: {
        usable: false, what_it_is: 'This file could not be read as a table.',
        proposed_name: record.original_name, proposed_key: '', contains: '', grain: '',
        join_key: 'none: comparison only', fills_gap: null, gap_confidence: 'none',
        gap_reasoning: 'The file could not be parsed.', columns: [],
        caveats: `DuckDB could not read it: ${previewData.error}`,
      },
      cost_dkk: 0, model: null,
    };
  } else {
    return {
      result: {
        usable: false, what_it_is: `Unrecognised file type (${record.file_kind}).`,
        proposed_name: record.original_name, proposed_key: '', contains: '', grain: '',
        join_key: 'none: comparison only', fills_gap: null, gap_confidence: 'none',
        gap_reasoning: 'Unsupported file type.', columns: [],
        caveats: 'Supported types are CSV, Excel, PDF, JSON and plain text.',
      },
      cost_dkk: 0, model: null,
    };
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6000,
      system: [{ type: 'text', text: INSTRUCTIONS }, { type: 'text', text: context }],
      // Structured output, so the shape is enforced by the API rather than
      // parsed hopefully out of prose.
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    if (/credit balance is too low/i.test(body)) {
      err.friendly = 'The Anthropic API account has no credit left, so the file could not be read. Top it up and try again.';
    }
    throw err;
  }

  const body = await res.json();
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let result;
  try {
    result = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (e) {
    throw new Error('The classifier returned something that was not valid JSON.');
  }

  const usage = body.usage || {};
  const costUsd = (usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out;

  return { result, cost_dkk: Number((costUsd * rateDkk).toFixed(2)), model: MODEL };
}

module.exports = { classify, SCHEMA, contextForClassifier, MODEL };
