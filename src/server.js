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
