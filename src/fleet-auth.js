// Shared logins with the fleet app.
//
// Copied in shape from bc-wiki/src/fleet-auth.js, which is the precedent on this
// VPS. This app has no passwords of its own: at login it opens the fleet
// database READ ONLY and checks email and password against team_members exactly
// as the fleet's own login does, then issues its own session cookie.
//
// ONE DELIBERATE DIFFERENCE FROM THE WIKI. The wiki lets every active team
// member in and assigns them a role. This app is for two people and holds every
// customer's name, email and phone number, so access is an explicit allowlist.
// Fede's PII decision of 2026-08-10 (allow identified rows when asked for) makes
// that allowlist a privacy control, not a convenience.

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

const FLEET_DB_PATH = process.env.FLEET_DB_PATH || '/var/www/becopenhagen-fleet/data/fleet.db';

// Who may use this tool. Two users, by name, per spec section 0.
const ALLOWED = (process.env.ALLOWED_MEMBERS || 'fede,soren')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

let fleetDb = null;

function openFleetDb() {
  const d = new DatabaseSync(FLEET_DB_PATH, { readOnly: true });
  // The fleet app and its hourly scraper both write this file. busy_timeout
  // lets our reads ride out a WAL checkpoint instead of failing instantly.
  d.exec('PRAGMA busy_timeout = 5000');
  return d;
}

// Reopen once if the handle went stale (the fleet app restarting invalidates
// it). A second failure propagates.
function fleetQuery(fn) {
  try {
    return fn(fleetDb || (fleetDb = openFleetDb()));
  } catch (e) {
    try { if (fleetDb) fleetDb.close(); } catch (_) { /* already gone */ }
    fleetDb = null;
    return fn(fleetDb = openFleetDb());
  }
}

// Copied from the fleet's src/auth.js so all three apps agree byte for byte.
//
// The salt is stored as a 32 character hex STRING and is passed to scrypt AS
// THAT STRING, so scrypt consumes its 32 ASCII bytes. Hex decoding it first
// produces a different key and every login silently fails.
function hashPassword(password, salt = null) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return { hash, salt: useSalt };
}

function verifyPassword(password, hash, salt) {
  // timingSafeEqual throws when buffer lengths differ, so a malformed row would
  // be a 500 rather than a clean "no".
  if (typeof hash !== 'string' || typeof salt !== 'string' || hash.length !== 128) return false;
  try {
    const { hash: testHash } = hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(hash, 'hex'));
  } catch (_) {
    return false;
  }
}

// { ok: true, member } or { ok: false, reason }
// reason: bad_credentials | needs_setup | not_allowed | fleet_db_unavailable
function verifyFleetLogin(email, password) {
  let member;
  try {
    member = fleetQuery(d => d.prepare(
      `SELECT id, name, role, is_guide, password_hash, password_salt, needs_password_setup
         FROM team_members
        WHERE lower(email) = lower(?) AND active = 1`
    ).get(String(email).trim()));
    // team_members.email has no UNIQUE constraint. Taking the first match is
    // what the fleet app does, so all three apps admit exactly the same person.
  } catch (e) {
    console.error('[fleet-auth] cannot read the fleet database:', e.message);
    return { ok: false, reason: 'fleet_db_unavailable' };
  }

  if (!member) return { ok: false, reason: 'bad_credentials' };
  if (member.needs_password_setup || !member.password_hash) return { ok: false, reason: 'needs_setup' };
  if (!verifyPassword(password, member.password_hash, member.password_salt)) {
    return { ok: false, reason: 'bad_credentials' };
  }
  // Password checked BEFORE the allowlist, deliberately: answering
  // "not allowed" to a wrong password would confirm the address exists.
  if (!ALLOWED.includes(String(member.id).toLowerCase())) {
    return { ok: false, reason: 'not_allowed' };
  }

  return { ok: true, member: { id: member.id, name: member.name, role: member.role } };
}

// Boot probe, so a broken path shows up in the logs at startup rather than as a
// mysterious 503 the first time someone tries to log in.
function countActiveMembers() {
  return fleetQuery(d => d.prepare(
    'SELECT COUNT(*) AS c FROM team_members WHERE active = 1').get()).c;
}

module.exports = { verifyFleetLogin, countActiveMembers, FLEET_DB_PATH, ALLOWED };
