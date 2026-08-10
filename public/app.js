'use strict';

// bc-data front end. Vanilla, one file, same as the fleet app and the wiki.

const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = { user: null, history: [], definitions: [], lastLogId: null, busy: false };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Login ──────────────────────────────────────────────────────────────────
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: { email: $('#email').value, password: $('#password').value },
    });
    state.user = user;
    showApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/session/logout', { method: 'POST' });
  location.reload();
});

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  loadFreshness();
  loadDefinitions();
}

// ── Freshness chip ─────────────────────────────────────────────────────────
async function loadFreshness() {
  try {
    const f = await api('/api/freshness');
    const chip = $('#freshness');
    const mins = f.age_minutes;
    const ago = mins < 60 ? `${mins} min ago`
      : mins < 1440 ? `${Math.round(mins / 60)} h ago`
      : `${Math.round(mins / 1440)} d ago`;
    chip.textContent = `Data as of ${String(f.loaded_at).slice(0, 16)} UTC (${ago})`;
    chip.classList.toggle('stale', !!f.stale);
  } catch { /* the chip is not worth an error message */ }
}

async function loadDefinitions() {
  try { state.definitions = await api('/api/definitions'); } catch { state.definitions = []; }
}

// ── Glossary auto-linking ──────────────────────────────────────────────────
// Fede asked for this explicitly: a defined term in an answer gets underlined
// and shows its agreed meaning on hover. Longest terms first so "revenue per
// pax" wins over "revenue", and each term is linked once per answer to avoid
// turning the text into a field of dotted underlines.
function linkGlossary(root) {
  if (!state.definitions.length) return;
  const terms = [...state.definitions].sort((a, b) => b.term.length - a.term.length);
  const used = new Set();

  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const d of terms) {
        if (used.has(d.term)) continue;
        const re = new RegExp(`\\b(${d.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
        const m = node.nodeValue.match(re);
        if (!m) continue;
        const span = el('span', 'term', m[0]);
        span.dataset.term = d.term;
        const after = node.splitText(m.index);
        after.nodeValue = after.nodeValue.slice(m[0].length);
        node.parentNode.insertBefore(span, after);
        used.add(d.term);
        walk(after);
        return;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE
               && !['CODE', 'PRE', 'SUMMARY'].includes(node.tagName)
               && !node.classList.contains('term')) {
      [...node.childNodes].forEach(walk);
    }
  };
  [...root.childNodes].forEach(walk);
}

const tip = $('#tooltip');
document.addEventListener('mouseover', e => {
  const t = e.target.closest?.('.term');
  if (!t) return;
  const d = state.definitions.find(x => x.term.toLowerCase() === t.dataset.term.toLowerCase());
  if (!d) return;
  tip.innerHTML = '';
  tip.appendChild(el('b', null, d.term));
  tip.appendChild(el('div', null, d.definition));
  if (d.do_not_use) tip.appendChild(el('span', 'dn', 'Do not: ' + d.do_not_use));
  tip.hidden = false;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 360)) + 'px';
  tip.style.top = (window.scrollY + r.bottom + 6) + 'px';
});
document.addEventListener('mouseout', e => {
  if (e.target.closest?.('.term')) tip.hidden = true;
});

// ── Minimal markdown, enough for what the model actually writes ────────────
function renderMarkdown(md) {
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = s => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { out.push(`<h3>${inline(line.replace(/^#+\s*/, ''))}</h3>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*[-*]\s+/, '')));
      out.push(`<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*\d+\.\s+/, '')));
      out.push(`<ol>${items.map(x => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}

// ── Ask ────────────────────────────────────────────────────────────────────
const thread = $('#thread');
const questionBox = $('#question');

questionBox.addEventListener('input', () => {
  questionBox.style.height = 'auto';
  questionBox.style.height = questionBox.scrollHeight + 'px';
});
questionBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask-form').requestSubmit(); }
});
document.addEventListener('click', e => {
  if (e.target.classList?.contains('suggest')) {
    questionBox.value = e.target.textContent;
    $('#ask-form').requestSubmit();
  }
});

$('#ask-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = questionBox.value.trim();
  if (!q || state.busy) return;
  questionBox.value = '';
  questionBox.style.height = 'auto';
  await ask(q);
});

function addUser(text) {
  $('.welcome')?.remove();
  const msg = el('div', 'msg user');
  msg.appendChild(el('div', 'bubble', text));
  thread.appendChild(msg);
  msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function ask(question, resume = null) {
  state.busy = true;
  $('#send').disabled = true;
  if (!resume) addUser(question);

  // A reply to an existing answer is treated as a correction as well as a
  // question: it is recorded permanently and fed into every later answer.
  if (state.lastLogId && looksLikeCorrection(question)) {
    api('/api/correction', {
      method: 'POST',
      body: { correction: question, context: state.history.at(-1)?.answer?.slice(0, 800), query_log_id: state.lastLogId },
    }).catch(() => {});
  }

  const msg = el('div', 'msg bot');
  const bubble = el('div', 'bubble');
  const thinking = el('div', 'thinking');
  thinking.innerHTML = 'Thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';
  bubble.appendChild(thinking);
  msg.appendChild(bubble);
  thread.appendChild(msg);
  msg.scrollIntoView({ behavior: 'smooth', block: 'end' });

  let answer = '';
  let meta = null;
  let paused = false;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, resume, history: state.history.slice(-3) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const chunk of chunks) {
        const ev = chunk.match(/^event: (.+)$/m)?.[1];
        const dataLine = chunk.match(/^data: (.+)$/m)?.[1];
        if (!ev || !dataLine) continue;
        const data = JSON.parse(dataLine);

        if (ev === 'text') {
          answer += (answer ? '\n\n' : '') + data.text;
          thinking.remove();
          bubble.innerHTML = renderMarkdown(answer);
          linkGlossary(bubble);
        } else if (ev === 'tool') {
          thinking.textContent = data.name === 'run_sql' ? 'Running a query…'
            : data.name === 'find_canonical_query' ? 'Checking the verified queries…'
            : data.name === 'describe_table' ? 'Reading the data dictionary…'
            : 'Looking things up…';
        } else if (ev === 'budget') {
          // Fede's per-question spending limit. The work done so far is kept
          // server-side, so continuing costs only what comes next rather than
          // paying twice for the part already answered.
          thinking.remove();
          bubble.appendChild(budgetPrompt(data, bubble));
          paused = true;
        } else if (ev === 'done') {
          meta = data;
        } else if (ev === 'error') {
          thinking.remove();
          bubble.appendChild(Object.assign(el('div', 'assertion'), { textContent: data.error }));
        }
      }
    }
  } catch (e) {
    thinking.remove();
    bubble.appendChild(Object.assign(el('div', 'assertion'), { textContent: e.message }));
  }

  thinking.remove();
  if (meta) renderMeta(bubble, meta);
  if (answer && !paused) state.history.push({ question, answer });
  if (meta?.query_log_id != null) state.lastLogId = meta.query_log_id;

  state.busy = false;
  $('#send').disabled = false;
  loadFreshness();
  msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/**
 * The over-budget prompt. Deliberately plain: how much it has cost, what it
 * would cost to carry on, and two buttons. No jargon, no token counts.
 */
function budgetPrompt(data, bubble) {
  const box = el('div', 'budget');
  box.appendChild(el('b', null, `This question has cost ${data.spent_dkk.toFixed(2)} DKK`));
  box.appendChild(el('p', null,
    `That is the ${data.budget_dkk} DKK limit for one question. ` +
    `It has not finished, and carrying on would cost more.`));

  const row = el('div', 'budget-actions');
  const go = el('button', 'budget-go', `Keep going (up to ${data.max_dkk} DKK)`);
  const stop = el('button', 'budget-stop', 'Stop here');

  go.addEventListener('click', () => {
    row.remove();
    box.appendChild(el('p', 'muted small', 'Continuing…'));
    ask(null, data.resume_token);
  });
  stop.addEventListener('click', () => {
    row.remove();
    box.appendChild(el('p', 'muted small',
      `Stopped at ${data.spent_dkk.toFixed(2)} DKK. Try asking something narrower.`));
  });

  row.appendChild(go);
  row.appendChild(stop);
  box.appendChild(row);
  return box;
}

function renderMeta(bubble, meta) {
  // Blocking assertions first: rule 9 says the violation replaces the number.
  for (const a of (meta.assertions || []).filter(x => x.severity === 'block')) {
    bubble.appendChild(Object.assign(el('div', 'assertion'), { textContent: a.message }));
  }
  for (const a of (meta.assertions || []).filter(x => x.severity === 'warn')) {
    bubble.appendChild(Object.assign(el('div', 'assertion warn'), { textContent: a.message }));
  }

  // Collapsed SQL. Not for auditing now, but so that when a number looks wrong
  // in six months the evidence still exists.
  for (const s of meta.sql || []) {
    const d = el('details', 'sql');
    d.appendChild(el('summary', null, `SQL (${s.rowCount} row${s.rowCount === 1 ? '' : 's'})`));
    if (s.purpose) d.appendChild(el('div', 'purpose', s.purpose));
    const pre = el('pre'); pre.textContent = s.sql; d.appendChild(pre);
    bubble.appendChild(d);
  }

  const bar = el('div', 'meta');
  if (meta.freshness?.loaded_at) {
    const chip = el('span', 'chip' + (meta.freshness.stale ? ' stale' : ''),
      `Data as of ${String(meta.freshness.loaded_at).slice(0, 16)} UTC`);
    bar.appendChild(chip);
  }
  // DKK, not dollars: it is what Fede thinks in and what the budget is set in.
  if (meta.cost_dkk != null) {
    const overBudget = meta.budget_dkk && meta.cost_dkk > meta.budget_dkk;
    bar.appendChild(Object.assign(el('span', 'attribution' + (overBudget ? ' over' : '')), {
      textContent: `${meta.cost_dkk.toFixed(2)} DKK · ${(meta.latency_ms / 1000).toFixed(1)}s` +
        (meta.cache_hit_ratio ? ` · ${Math.round(meta.cache_hit_ratio * 100)}% reused` : ''),
      title: meta.cache_hit_ratio
        ? `Reusing the cached background context keeps repeat questions cheap. $${meta.cost_usd?.toFixed(4)}`
        : `$${meta.cost_usd?.toFixed(4)}`,
    }));
  }
  bubble.appendChild(bar);

  if (meta.gap_cited) {
    const g = el('div', 'gap');
    g.appendChild(el('b', null, 'Missing data: '));
    g.appendChild(document.createTextNode(meta.gap_cited.replace(/_/g, ' ')));
    bubble.appendChild(g);
  }
}

// Heuristic, deliberately generous: over-recording a correction costs a row,
// under-recording loses knowledge that exists nowhere else.
function looksLikeCorrection(text) {
  return /\b(no|not|wrong|actually|isn'?t|aren'?t|incorrect|mistake|should be|we don'?t|we do|in fact|correction)\b/i.test(text);
}

// ── Other tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tabpane').forEach(p =>
      p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab !== 'ask') renderTab(btn.dataset.tab);
  });
});

async function renderTab(tab) {
  const pane = $(`#tab-${tab}`);
  pane.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (tab === 'sources') {
      const rows = await api('/api/sources');
      pane.innerHTML = '';
      pane.appendChild(el('p', 'muted small',
        'Where every number comes from, and what will bite you. Freshness is checked hourly.'));
      for (const s of rows) {
        const card = el('div', 'card');
        const h = el('h3', null, s.display_name || s.source_key);
        const age = s.last_loaded_at ? hoursSince(s.last_loaded_at) : null;
        const cls = age == null ? '' : age > (s.refresh_cadence_hours || 1) * 1.5 ? 'amber' : 'green';
        h.appendChild(Object.assign(el('span', `badge ${cls}`),
          { textContent: age == null ? 'never loaded' : `${Number(s.last_row_count).toLocaleString()} rows` }));
        card.appendChild(h);
        card.appendChild(el('div', 'key', s.source_key));
        if (s.description) card.appendChild(el('p', null, s.description));
        if (s.grain) card.appendChild(el('p', 'muted small', `One row = ${s.grain}`));
        const delta = s.prev_row_count != null ? s.last_row_count - s.prev_row_count : null;
        card.appendChild(el('p', 'muted small',
          `Loaded ${s.last_loaded_at || 'never'}` +
          (delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta} since previous load` : '') +
          (s.max_date_in_data ? ` · newest data ${s.max_date_in_data}` : '')));
        if (s.gotchas) card.appendChild(el('div', 'gotchas', s.gotchas));
        pane.appendChild(card);
      }
    } else if (tab === 'dictionary') {
      const rows = await api('/api/definitions');
      state.definitions = rows;
      pane.innerHTML = '';
      pane.appendChild(el('p', 'muted small',
        'The agreed meaning of each word. This is what stops two people getting different numbers for the same question.'));
      for (const d of rows) {
        const card = el('div', 'card');
        card.appendChild(el('h3', null, d.term));
        card.appendChild(el('p', null, d.definition));
        if (d.sql_snippet) card.appendChild(el('div', 'sqlsnip', d.sql_snippet));
        if (d.do_not_use) card.appendChild(el('div', 'donot', 'Do not: ' + d.do_not_use));
        pane.appendChild(card);
      }
    } else if (tab === 'gaps') {
      const rows = await api('/api/gaps');
      pane.innerHTML = '';
      pane.appendChild(el('p', 'muted small',
        'What is missing, and what it would unlock. Ranked by how often it has actually blocked an answer, so this is the data roadmap.'));
      for (const g of rows) {
        const card = el('div', 'card');
        const h = el('h3', null, g.missing);
        h.appendChild(Object.assign(el('span', 'badge'), { textContent: `${g.effort} effort` }));
        if (g.cited_count) h.appendChild(Object.assign(el('span', 'badge amber'),
          { textContent: `blocked ${g.cited_count} answer${g.cited_count === 1 ? '' : 's'}` }));
        card.appendChild(h);
        card.appendChild(el('p', null, 'Would unlock: ' + g.unlocks));
        card.appendChild(el('p', 'muted small', 'How to get it: ' + g.how_to_get));
        pane.appendChild(card);
      }
    }
  } catch (e) {
    pane.innerHTML = '';
    pane.appendChild(Object.assign(el('div', 'error'), { textContent: e.message }));
  }
}

function hoursSince(ts) {
  const t = new Date(String(ts).replace(' ', 'T') + 'Z');
  return (Date.now() - t.getTime()) / 3600000;
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const { user } = await api('/session/me');
    if (user) { state.user = user; showApp(); }
    else $('#login').hidden = false;
  } catch {
    $('#login').hidden = false;
  }
})();
