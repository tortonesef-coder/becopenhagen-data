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
  loadDoubtCount();
  loadCuratorCount();
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

async function loadDoubtCount() {
  try {
    const { counts } = await api('/api/doubts');
    const badge = $('#doubt-count');
    if (Number(counts.open) > 0) { badge.textContent = counts.open; badge.hidden = false; }
    else badge.hidden = true;
  } catch { /* the badge is not worth an error */ }
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

    // Fenced code. Must come first: a fence line matches nothing else here, so
    // without this branch it falls through to the paragraph handler, which
    // joins every line with a space and prints the backticks. The answer then
    // shows a whole query on one unreadable line, which is what Fede hit.
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;   // the closing fence, or the end of the text if the model forgot it
      out.push(`<pre class="codeblock"${lang ? ` data-lang="${esc(lang)}"` : ''}>` +
               `<code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

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
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*\||\s*```)/.test(lines[i])) para.push(lines[i++]);
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
      pane.appendChild(buildDropZone());
      await renderPendingUploads(pane);
      pane.appendChild(el('p', 'muted small',
        'Every source, every datapoint inside it, what will bite you, and how much work it has actually done. ' +
        'Freshness is checked hourly.'));
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
        card.appendChild(usageLine(s.usage));
        if (s.columns.length) card.appendChild(columnsBlock(s.columns));
        if (s.gotchas) card.appendChild(el('div', 'gotchas', s.gotchas));
        pane.appendChild(card);
      }
    } else if (tab === 'curator') {
      await renderCurator(pane);
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
    } else if (tab === 'doubts') {
      await renderDoubts(pane);
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

// ── The library: how hard a source is working ──────────────────────────────
// Three numbers, and the third is the one that matters. "Used" is just how
// often it appeared in a query, which mostly measures how convenient it is to
// join. "Carried the answer" is the model saying the headline number came out
// of it, and that is the number worth reading.
function usageLine(u) {
  if (!u || !Number(u.times_used)) {
    return el('p', 'usage muted small', 'Never used in an answer yet.');
  }
  const p = el('p', 'usage small');
  const used = Number(u.times_used), mattered = Number(u.times_mattered);
  p.appendChild(Object.assign(el('span', 'badge' + (mattered ? ' green' : '')),
    { textContent: `${mattered} of ${used} answers` }));
  p.appendChild(document.createTextNode(
    mattered
      ? ` carried by this source${Number(u.times_decisive) ? `, ${u.times_decisive} where it changed the conclusion` : ''}.`
      : ` used it, but it has never carried the number. It may be getting joined out of habit.`));
  if (Number(u.in_corrected_answers)) {
    p.appendChild(Object.assign(el('span', 'badge amber'),
      { textContent: `${u.in_corrected_answers} corrected` }));
  }
  return p;
}

/** The datapoints. Collapsed by default: some tables have forty columns. */
function columnsBlock(cols) {
  const unreviewed = cols.filter(c => !c.reviewed).length;
  const d = el('details', 'cols');
  const sum = el('summary', null,
    `${cols.length} datapoint${cols.length === 1 ? '' : 's'}` +
    (unreviewed ? ` · ${unreviewed} not yet checked by a person` : ' · all checked'));
  d.appendChild(sum);
  for (const c of cols) {
    const row = el('div', 'col-row');
    const name = el('span', 'col-name', c.column_name);
    if (c.is_pii) name.appendChild(Object.assign(el('span', 'badge amber'), { textContent: 'personal' }));
    if (!c.reviewed) name.appendChild(Object.assign(el('span', 'badge'), { textContent: 'unchecked' }));
    row.appendChild(name);
    row.appendChild(el('span', 'col-type', c.data_type || ''));
    if (c.description) row.appendChild(el('span', 'col-desc', c.description));
    if (c.gotcha) row.appendChild(el('span', 'col-desc warnish', c.gotcha));
    d.appendChild(row);
  }
  return d;
}

// ── Curator ────────────────────────────────────────────────────────────────
// Suggestions only, and every one of them adds something. There is deliberately
// no button here that changes or removes an existing source: the promise is
// additive-only, and a screen that can do both cannot make that promise.
async function renderCurator(pane) {
  let data;
  try { data = await api('/api/curator'); }
  catch (e) { pane.innerHTML = ''; pane.appendChild(Object.assign(el('div','error'),{textContent:e.message})); return; }

  pane.innerHTML = '';
  pane.appendChild(el('p', 'muted small',
    'Things that could be joined up, data sitting unused, and documents whose numbers are not queryable yet. ' +
    'Every suggestion only ever adds something. Nothing here changes or deletes a source, so saying yes cannot break an existing answer.'));
  pane.appendChild(el('p', 'muted small',
    `${data.counts.open} open, ${data.counts.accepted} accepted, ${data.counts.rejected} turned down.`));

  if (!data.queue.length) {
    pane.appendChild(Object.assign(el('div', 'card'),
      { textContent: 'Nothing to suggest right now. It looks again every night.' }));
    return;
  }

  for (const p of data.queue) {
    const card = el('div', 'card');
    const kind = el('div', 'doubt-kind');
    kind.appendChild(Object.assign(el('span', 'badge' + (p.confidence === 'high' ? ' green' : p.confidence === 'low' ? ' amber' : '')),
      { textContent: p.kind.replace(/_/g, ' ') }));
    kind.appendChild(Object.assign(el('span', 'key'), { textContent: p.affects }));
    card.appendChild(kind);

    card.appendChild(el('h3', null, p.title));
    card.appendChild(el('p', null, p.rationale));
    if (p.evidence) {
      const pre = el('pre', 'doubt-detail');
      pre.textContent = p.evidence;
      card.appendChild(pre);
    }
    if (p.proposed_sql) {
      card.appendChild(el('p', 'muted small', 'If you accept, this is what gets run:'));
      card.appendChild(el('div', 'sqlsnip', p.proposed_sql));
    }

    const note = el('textarea');
    note.className = 'doubt-note';
    note.rows = 2;
    note.placeholder = 'Turning it down? Say why, and it will stop suggesting this (optional)';
    card.appendChild(note);

    const row = el('div', 'budget-actions');
    const yes = el('button', 'doubt-yes', '✓  Worth doing');
    const no = el('button', 'doubt-no', '✗  No');
    yes.addEventListener('click', () => decideProposal(card, p.proposal_id, 'accepted', note.value));
    no.addEventListener('click', () => decideProposal(card, p.proposal_id, 'rejected', note.value));
    row.appendChild(yes); row.appendChild(no);
    card.appendChild(row);
    pane.appendChild(card);
  }
}

async function decideProposal(card, id, decision, note) {
  const inner = card.innerHTML;
  card.innerHTML = '<div class="loading">Saving…</div>';
  try {
    const out = await api(`/api/curator/${id}/decide`, { method: 'POST', body: { decision, note: note || null } });
    card.innerHTML = '';
    card.appendChild(el('p', 'muted small',
      decision === 'accepted' ? 'Accepted.' : 'Turned down, and the reason is saved so it stops asking.'));
    // An accepted proposal is a decision, not an action. Saying what to run
    // next beats a screen that quietly ran it.
    if (out.next_step) {
      card.appendChild(el('p', 'muted small', 'Next step, on the server:'));
      card.appendChild(el('div', 'sqlsnip', out.next_step));
    }
    loadCuratorCount();
  } catch (e) {
    card.innerHTML = inner;
    card.appendChild(Object.assign(el('div', 'error'), { textContent: e.message }));
  }
}

async function loadCuratorCount() {
  try {
    const { counts } = await api('/api/curator');
    const badge = $('#curator-count');
    if (Number(counts.open) > 0) { badge.textContent = counts.open; badge.hidden = false; }
    else badge.hidden = true;
  } catch { /* the badge is not worth an error */ }
}

// ── Upload ─────────────────────────────────────────────────────────────────
// Drop a file, a model reads it and says what it thinks it is, you confirm.
// Nothing reaches the warehouse until you have said yes: a model reading a
// spreadsheet header is a good guess, and a wrong guess accepted silently would
// be believed by every answer built on it afterwards.
function buildDropZone() {
  const box = el('div', 'dropzone');
  box.innerHTML =
    '<b>Add a data file</b>' +
    '<p class="muted small">Drop a CSV, Excel, PDF or JSON here, or click to choose. ' +
    'It gets read and described, and you decide whether to keep it. ' +
    'Reading a file costs about 1 to 3 DKK.</p>';
  const input = el('input');
  input.type = 'file';
  input.hidden = true;
  box.appendChild(input);

  const go = f => f && sendUpload(f, box);
  box.addEventListener('click', () => input.click());
  input.addEventListener('change', () => go(input.files[0]));
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', e => {
    e.preventDefault(); box.classList.remove('over');
    go(e.dataTransfer.files[0]);
  });
  return box;
}

async function sendUpload(file, box) {
  const status = el('div', 'upload-status');
  status.textContent = `Reading ${file.name}...`;
  box.appendChild(status);

  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/sources/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    status.remove();
    box.parentElement.insertBefore(proposalCard(data), box.nextSibling);
  } catch (e) {
    status.className = 'upload-status error';
    status.textContent = e.message;
  }
}

function proposalCard(d) {
  const card = el('div', 'card proposal');
  const h = el('h3', null, d.proposed_name || d.original_name || 'Uploaded file');
  if (!d.usable) h.appendChild(Object.assign(el('span', 'badge red'), { textContent: 'not usable' }));
  card.appendChild(h);

  card.appendChild(el('p', null, d.what_it_is));
  if (d.grain) card.appendChild(el('p', 'muted small', `One row = ${d.grain}`));
  if (d.join_key) {
    const j = el('p', 'muted small');
    j.textContent = String(d.join_key).startsWith('none:')
      ? 'Cannot be joined to your existing data: usable for comparison only.'
      : `Connects to your data via ${d.join_key}`;
    card.appendChild(j);
  }

  if (d.fills_gap) {
    const g = el('div', 'gap');
    g.appendChild(el('b', null, 'Fills a known gap: '));
    g.appendChild(document.createTextNode(
      `${String(d.fills_gap).replace(/_/g, ' ')} (${d.gap_confidence} confidence). ${d.gap_reasoning || ''}`));
    card.appendChild(g);
  }

  const pii = (d.columns || []).filter(c => c.is_pii);
  if (pii.length) {
    card.appendChild(Object.assign(el('div', 'assertion warn'), {
      textContent: `Contains personal data: ${pii.map(c => c.name).join(', ')}.`,
    }));
  }
  if (d.caveats) {
    card.appendChild(Object.assign(el('div', 'assertion warn'), { textContent: d.caveats }));
  }

  if ((d.columns || []).length) {
    const det = el('details', 'sql');
    det.appendChild(el('summary', null, `${d.columns.length} columns`));
    const pre = el('pre');
    pre.textContent = d.columns.map(c =>
      `${c.name} (${c.type})${c.is_pii ? ' [personal]' : ''}\n    ${c.description}`).join('\n');
    det.appendChild(pre);
    card.appendChild(det);
  }

  card.appendChild(el('p', 'attribution',
    `Read by ${d.file_kind} reader, cost ${Number(d.cost_dkk || 0).toFixed(2)} DKK`));

  if (d.usable) {
    const row = el('div', 'budget-actions');
    const keep = el('button', 'budget-go', 'Keep it');
    const drop = el('button', 'budget-stop', 'Discard');
    keep.addEventListener('click', () => decideUpload(d.upload_id, 'confirm', card));
    drop.addEventListener('click', () => decideUpload(d.upload_id, 'reject', card));
    row.appendChild(keep); row.appendChild(drop);
    card.appendChild(row);
  } else {
    const row = el('div', 'budget-actions');
    const drop = el('button', 'budget-stop', 'Discard');
    drop.addEventListener('click', () => decideUpload(d.upload_id, 'reject', card));
    row.appendChild(drop);
    card.appendChild(row);
  }
  return card;
}

async function decideUpload(id, decision, card) {
  card.querySelector('.budget-actions')?.remove();
  const status = el('p', 'muted small', decision === 'confirm' ? 'Loading it in...' : 'Discarding...');
  card.appendChild(status);
  try {
    const out = await api(`/api/sources/upload/${id}/decide`, { method: 'POST', body: { decision } });
    if (out.status === 'ingested') {
      status.textContent = `Added as ${out.table} with ${Number(out.rows).toLocaleString()} rows.` +
        (out.gap_closed ? ` The "${String(out.gap_closed).replace(/_/g, ' ')}" gap is now filled.` : '');
      status.className = 'muted small done';
    } else {
      status.textContent = 'Discarded.';
      setTimeout(() => card.remove(), 1200);
    }
  } catch (e) {
    status.className = 'error';
    status.textContent = e.message;
  }
}

async function renderPendingUploads(pane) {
  let rows = [];
  try { rows = await api('/api/sources/uploads'); } catch { return; }
  const pending = rows.filter(r => r.status === 'proposed');
  if (!pending.length) return;
  pane.appendChild(el('p', 'muted small', `${pending.length} uploaded file(s) waiting for a decision:`));
  for (const r of pending) {
    pane.appendChild(proposalCard({ ...r, columns: [], usable: true, cost_dkk: r.classify_cost_dkk }));
  }
}

// ── Doubts ─────────────────────────────────────────────────────────────────
// Fede asked for "atomic nuggets of doubt, which I can confirm or deny, check
// mark or big X". One card at a time on purpose: a list of 207 questions is a
// wall nobody starts, one question with two buttons is a decision.
//
// Ordered by what a wrong answer would cost, not by how unsure the model is.
// Money and the queries the tool trusts verbatim come first; column wording
// comes last.
async function renderDoubts(pane) {
  pane.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try { data = await api('/api/doubts'); }
  catch (e) { pane.innerHTML = ''; pane.appendChild(Object.assign(el('div','error'),{textContent:e.message})); return; }

  state.doubtQueue = data.queue;
  state.doubtIndex = 0;
  pane.innerHTML = '';

  const head = el('div', 'doubt-head');
  head.appendChild(el('p', 'muted small',
    'Everything the models are unsure about, one question at a time. ' +
    'A tick marks it checked; a cross records why it was wrong and feeds that back in. ' +
    'Ordered by what a wrong answer would cost.'));
  const tally = el('p', 'muted small');
  tally.id = 'doubt-tally';
  head.appendChild(tally);
  pane.appendChild(head);

  const kinds = el('div', 'doubt-kinds');
  for (const k of data.by_kind) {
    kinds.appendChild(Object.assign(el('span', 'badge'),
      { textContent: `${k.n} ${k.kind.replace(/_/g, ' ')}` }));
  }
  pane.appendChild(kinds);

  const slot = el('div');
  slot.id = 'doubt-slot';
  pane.appendChild(slot);
  showDoubt(data.counts);
}

function showDoubt(counts) {
  const slot = $('#doubt-slot');
  const tally = $('#doubt-tally');
  if (!slot) return;
  slot.innerHTML = '';

  const d = state.doubtQueue[state.doubtIndex];
  if (!d) {
    slot.appendChild(Object.assign(el('div', 'card'), {
      textContent: state.doubtQueue.length
        ? 'That is the batch done. Reload for the next fifty.'
        : 'Nothing to check right now.',
    }));
    return;
  }

  if (tally && counts) {
    tally.textContent = `${counts.open} open, ${counts.confirmed} confirmed, ` +
      `${counts.denied} corrected, ${counts.skipped} skipped.`;
  }

  const card = el('div', 'card doubt');
  const kind = el('div', 'doubt-kind');
  kind.appendChild(Object.assign(el('span', 'badge' + (d.priority <= 2 ? ' amber' : '')),
    { textContent: d.kind.replace(/_/g, ' ') }));
  kind.appendChild(Object.assign(el('span', 'key'), { textContent: d.subject }));
  card.appendChild(kind);

  card.appendChild(el('h3', null, d.question));
  if (d.detail) {
    const pre = el('pre', 'doubt-detail');
    pre.textContent = d.detail;
    card.appendChild(pre);
  }
  if (d.impact) card.appendChild(el('p', 'doubt-impact', d.impact));

  const note = el('textarea');
  note.className = 'doubt-note';
  note.rows = 2;
  note.placeholder = 'The right answer, or anything worth knowing. Whatever you write here is kept and used, even if you tick Correct.';
  card.appendChild(note);

  const row = el('div', 'budget-actions');
  const yes = el('button', 'doubt-yes', '\u2713  Correct');
  const no = el('button', 'doubt-no', '\u2717  Wrong');
  const skip = el('button', 'budget-stop', 'Skip');
  yes.addEventListener('click', () => decideDoubt(d.doubt_id, 'confirmed', note.value));
  no.addEventListener('click', () => decideDoubt(d.doubt_id, 'denied', note.value));
  skip.addEventListener('click', () => decideDoubt(d.doubt_id, 'skipped', note.value));
  row.appendChild(yes); row.appendChild(no); row.appendChild(skip);
  card.appendChild(row);

  const pos = el('p', 'muted small', `${state.doubtIndex + 1} of ${state.doubtQueue.length} in this batch`);
  card.appendChild(pos);
  slot.appendChild(card);
}

async function decideDoubt(id, decision, note) {
  const slot = $('#doubt-slot');
  slot.innerHTML = '<div class="loading">Saving…</div>';
  try {
    const out = await api(`/api/doubts/${id}/decide`, { method: 'POST', body: { decision, note: note || null } });
    state.doubtIndex++;
    showDoubt({ open: out.open, confirmed: '', denied: '', skipped: '' });
    const tally = $('#doubt-tally');
    if (tally) tally.textContent = `${out.open} left to check.`;
    // Say what happened to the note. Ticking Correct and typing "no, it is 20%"
    // is a real thing people do, and the two disagree, so the tick does not get
    // to mark it verified on your behalf.
    if (out.held_back) {
      $('#doubt-slot')?.prepend(Object.assign(el('div', 'notekept'),
        { textContent: 'Your note is saved and will be used. Because it might disagree with the tick, this one is not marked verified yet.' }));
    } else if (out.note_kept) {
      $('#doubt-slot')?.prepend(Object.assign(el('div', 'notekept'), { textContent: 'Note saved.' }));
    }
    loadDoubtCount();
  } catch (e) {
    slot.innerHTML = '';
    slot.appendChild(Object.assign(el('div', 'error'), { textContent: e.message }));
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
