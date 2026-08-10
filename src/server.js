// bc-data. Express, sessions, four routes, no framework beyond that.
//
// Deliberately independent of the fleet app: its own process, its own port, its
// own database files. It opens the fleet database READ ONLY, only to verify a
// login, and can never write to it.

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');

const db = require('./db');
const context = require('./context');
const agent = require('./agent');
const { verifyFleetLogin, countActiveMembers, FLEET_DB_PATH, ALLOWED } = require('./fleet-auth');

// pm2 does not inherit /etc/environment. The fleet app reads it manually at
// startup and so must we, or ANTHROPIC_API_KEY is missing in production only.
try {
  for (const line of fs.readFileSync('/etc/environment', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* not fatal: .env or the real environment may already have it */ }

// A local .env for the values that are NOT shared with the fleet app
// (SESSION_SECRET, PORT). Parsed by hand rather than pulling in dotenv for six
// lines: fewer dependencies is the house style here.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
    if (m && m[2] !== '') process.env[m[1]] = m[2];
  }
} catch { /* no .env is fine if the real environment has everything */ }

const app = express();
const PORT = Number(process.env.PORT || 4200);

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Refusing to start with an insecure fallback.');
  process.exit(1);
}

app.set('trust proxy', 1); // Caddy terminates TLS
app.use(express.json({ limit: '256kb' }));

app.use(session({
  // NOT connect.sid (bc-fleet) and NOT wiki.sid (bc-wiki): cookies ignore ports,
  // so a shared name collides with the other two apps during IP testing.
  name: 'data.sid',
  store: new FileStore({
    path: path.join(__dirname, '../data/sessions'),
    ttl: 60 * 60 * 24 * 7,
    retries: 1,
    logFn: () => {},
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

function requireAuth(req, res, next) {
  if (req.session?.username) return next();
  res.status(401).json({ error: 'Not logged in.' });
}

// ── Auth ────────────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const result = verifyFleetLogin(email, password);
  if (!result.ok) {
    if (result.reason === 'needs_setup') {
      return res.status(403).json({ error: 'No password set yet. Set one in the Fleet app first.' });
    }
    if (result.reason === 'fleet_db_unavailable') {
      return res.status(503).json({ error: 'Login is temporarily unavailable. Try again in a minute.' });
    }
    if (result.reason === 'not_allowed') {
      return res.status(403).json({ error: 'This tool is limited to Federico and Søren.' });
    }
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  req.session.username = result.member.id;
  req.session.displayName = result.member.name;
  res.json({ ok: true, user: { username: result.member.id, name: result.member.name } });
});

app.get('/session/me', (req, res) => {
  res.json(req.session?.username
    ? { user: { username: req.session.username, name: req.session.displayName } }
    : { user: null });
});

app.post('/session/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('data.sid'); res.json({ ok: true }); });
});

// ── Ask ─────────────────────────────────────────────────────────────────────
app.post('/api/ask', requireAuth, async (req, res) => {
  // A resume carries no question: it continues one that paused on the budget.
  const resume = req.body?.resume ? String(req.body.resume) : null;
  const question = String(req.body?.question || '').trim();
  if (!question && !resume) return res.status(400).json({ error: 'Ask something.' });
  if (question.length > 4000) return res.status(400).json({ error: 'That question is too long.' });

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await agent.ask({ question, username: req.session.username, history, resume }, emit);
  } catch (e) {
    console.error('[ask]', e.message);
    emit('error', { error: e.friendly || 'Something went wrong answering that. The error is in the server log.' });
  }
  res.end();
});

// A reply that corrects an answer. Fede, 2026-08-10: this is often the most
// valuable thing said in the whole exchange, and it exists nowhere else.
app.post('/api/correction', requireAuth, async (req, res) => {
  const { correction, context: ctxText, query_log_id, applies_to } = req.body || {};
  if (!correction || !String(correction).trim()) return res.status(400).json({ error: 'Nothing to record.' });
  try {
    await db.logCorrection({
      said_by: req.session.username,
      correction: String(correction).slice(0, 4000),
      context: ctxText ? String(ctxText).slice(0, 2000) : null,
      query_log_id: query_log_id ?? null,
      applies_to: applies_to || null,
    });
    // The correction feeds the next answer, so the prompt must be rebuilt.
    await context.reload();
    res.json({ ok: true });
  } catch (e) {
    console.error('[correction]', e.message);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

// ── Upload: propose, then confirm ───────────────────────────────────────────
// Nothing reaches the warehouse until a person has read what the classifier
// made of the file and said yes. See src/uploads.js for why.
const multer = require('multer');
const uploads = require('./uploads');
const classify = require('./classify');
const ingest = require('./ingest');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploads.MAX_BYTES } });

app.post('/api/sources/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  let record;
  try {
    record = uploads.store(req.file.buffer, req.file.originalname, req.file.mimetype, req.session.username);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const [{ value: rate } = {}] = await db.catalog(
      `SELECT value FROM catalog.settings WHERE key = 'usd_to_dkk'`);
    const previewData = await uploads.preview(record);
    const { result, cost_dkk, model } = await classify.classify(record, previewData,
      { rateDkk: Number(rate || 6.9) });

    await db.catalogWrite(`
      INSERT INTO catalog.uploads
        (upload_id, uploaded_at, uploaded_by, original_name, stored_path, mime_type,
         size_bytes, file_kind, proposed_name, proposed_key, what_it_is, contains,
         grain, join_key, fills_gap, gap_confidence, columns_json, caveats,
         classifier_model, classify_cost_dkk, status)
      VALUES (${db.esc(record.upload_id)}, now(), ${db.esc(record.uploaded_by)},
              ${db.esc(record.original_name)}, ${db.esc(record.stored_path)},
              ${db.esc(record.mime_type)}, ${record.size_bytes}, ${db.esc(record.file_kind)},
              ${db.esc(result.proposed_name)}, ${db.esc(result.proposed_key)},
              ${db.esc(result.what_it_is)}, ${db.esc(result.contains)}, ${db.esc(result.grain)},
              ${db.esc(result.join_key)}, ${db.esc(result.fills_gap)},
              ${db.esc(result.gap_confidence)}, ${db.esc(JSON.stringify(result.columns || []))},
              ${db.esc(result.caveats)}, ${db.esc(model)}, ${cost_dkk},
              ${result.usable ? "'proposed'" : "'failed'"});`);

    res.json({ upload_id: record.upload_id, file_kind: record.file_kind,
               size_bytes: record.size_bytes, cost_dkk, ...result });
  } catch (e) {
    console.error('[upload]', e.message);
    uploads.remove(record.upload_id);
    res.status(500).json({ error: e.friendly || 'Could not read that file. The error is in the server log.' });
  }
});

app.post('/api/sources/upload/:id/decide', requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const decision = req.body?.decision === 'confirm' ? 'confirm' : 'reject';

  const [row] = await db.catalog(
    `SELECT * FROM catalog.uploads WHERE upload_id = ${db.esc(id)}`);
  if (!row) return res.status(404).json({ error: 'No such upload.' });
  if (row.status !== 'proposed') {
    return res.status(409).json({ error: `That upload is already ${row.status}.` });
  }

  if (decision === 'reject') {
    await db.catalogWrite(`
      UPDATE catalog.uploads SET status='rejected', decided_by=${db.esc(req.session.username)},
        decided_at=now(), reject_reason=${db.esc(req.body?.reason || null)}
      WHERE upload_id = ${db.esc(id)};`);
    uploads.remove(id);
    return res.json({ ok: true, status: 'rejected' });
  }

  // The person may correct the classifier before confirming. Their edit wins.
  const merged = {
    ...row,
    decided_by: req.session.username,
    proposed_name: req.body?.proposed_name || row.proposed_name,
    proposed_key: req.body?.proposed_key || row.proposed_key,
    fills_gap: req.body?.fills_gap !== undefined ? req.body.fills_gap : row.fills_gap,
  };

  try {
    const out = await ingest.ingest(merged);
    const reg = await ingest.register(merged, out);
    await db.catalogWrite(`
      UPDATE catalog.uploads SET status='ingested', decided_by=${db.esc(req.session.username)},
        decided_at=now(), ingested_rows=${out.rows}, ingested_path=${db.esc(out.parquet)},
        proposed_key=${db.esc('bc.' + out.table)}, fills_gap=${db.esc(merged.fills_gap)}
      WHERE upload_id = ${db.esc(id)};`);
    await ingest.writeRebuildScript();
    await context.reload();   // the new source belongs in the agent's prompt
    res.json({ ok: true, status: 'ingested', ...reg });
  } catch (e) {
    console.error('[ingest]', e.message);
    await db.catalogWrite(`
      UPDATE catalog.uploads SET status='failed', error=${db.esc(e.message)}
      WHERE upload_id = ${db.esc(id)};`).catch(() => {});
    res.status(500).json({ error: e.friendly || `Could not load that file: ${e.message}` });
  }
});

app.get('/api/sources/uploads', requireAuth, async (_req, res) => {
  try {
    res.json(await db.catalog(`
      SELECT upload_id, uploaded_at, uploaded_by, original_name, file_kind, size_bytes,
             proposed_name, proposed_key, what_it_is, grain, join_key, fills_gap,
             gap_confidence, caveats, status, ingested_rows, classify_cost_dkk, error
      FROM catalog.uploads ORDER BY uploaded_at DESC LIMIT 50`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sources, Dictionary, Gaps (read-only for now; CRUD lands in phase 7) ────
app.get('/api/sources', requireAuth, async (_req, res) => {
  try {
    res.json(await db.catalog(`
      SELECT source_key, display_name, description, grain, gotchas, refresh_cadence_hours,
             retrieval_method, retrieval_instructions, last_loaded_at, last_row_count,
             prev_row_count, max_date_in_data
      FROM catalog.sources ORDER BY source_key`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/definitions', requireAuth, async (_req, res) => {
  try {
    res.json(await db.catalog(
      `SELECT term, definition, sql_snippet, do_not_use, updated_at, updated_by
       FROM catalog.definitions ORDER BY term`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gaps', requireAuth, async (_req, res) => {
  try {
    res.json(await db.catalog(
      `SELECT gap_key, missing, unlocks, how_to_get, effort, cited_count
       FROM catalog.gaps ORDER BY cited_count DESC, gap_key`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/freshness', requireAuth, async (_req, res) => {
  try { res.json(await agent.freshness()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/healthz', async (_req, res) => {
  try {
    const [f] = await db.warehouse('SELECT loaded_at FROM bc.data_freshness');
    res.json({ ok: true, data_as_of: f?.loaded_at || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.use(express.static(path.join(__dirname, '../public')));

(async () => {
  // Fail loudly at boot rather than as a mysterious 503 on first use.
  try {
    console.log(`[boot] fleet database: ${FLEET_DB_PATH} (read only), ${countActiveMembers()} active members`);
  } catch (e) {
    console.error(`[boot] CANNOT READ THE FLEET DATABASE at ${FLEET_DB_PATH}: ${e.message}`);
    console.error('[boot] Nobody will be able to log in. Check the path.');
  }
  console.log(`[boot] allowed users: ${ALLOWED.join(', ')}`);

  try {
    const block = await context.build();
    console.log(`[boot] static context built: ${block.length} chars, cached as a prompt prefix`);
  } catch (e) {
    console.error('[boot] could not build the static context:', e.message);
    process.exit(1);
  }

  try {
    const [f] = await db.warehouse('SELECT loaded_at FROM bc.data_freshness');
    console.log(`[boot] warehouse ${db.WAREHOUSE}, data as of ${f?.loaded_at}`);
  } catch (e) {
    console.error('[boot] warehouse unreadable:', e.message);
  }

  app.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
    console.log(`[boot] bc-data listening on ${PORT}, model ${agent.MODEL}`);
  });
})();
