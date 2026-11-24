import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS productions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  industry TEXT NOT NULL,            -- hi | te | ta | kn | ml
  langs TEXT NOT NULL DEFAULT '[]',  -- JSON array of shooting languages
  fixed_cost INTEGER NOT NULL DEFAULT 0,   -- rupees: committed fees + pre-production
  day_cost INTEGER NOT NULL,               -- rupees: planned cost of one shoot day
  planned_days INTEGER NOT NULL,
  per_head INTEGER NOT NULL DEFAULT 6000,  -- rupees per extra entourage member per day
  van_day INTEGER NOT NULL DEFAULT 45000,  -- rupees per extra vanity van per day
  company TEXT NOT NULL DEFAULT '',        -- Tally company name
  gstin TEXT NOT NULL DEFAULT '',
  state_code TEXT NOT NULL DEFAULT '36',   -- GST state code of the production office
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, production_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  actor_id INTEGER,                   -- for actor's managers: which actor they represent
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT '',
  fee INTEGER NOT NULL DEFAULT 0,
  terms_vans INTEGER NOT NULL DEFAULT 1,
  terms_entourage INTEGER NOT NULL DEFAULT 2,
  per_diem INTEGER NOT NULL DEFAULT 0,
  used_vans INTEGER NOT NULL DEFAULT 1,
  used_entourage INTEGER NOT NULL DEFAULT 2,
  manager_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS unavailability (
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (actor_id, date)
);

CREATE TABLE IF NOT EXISTS shoot_days (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  date TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  actual_cost INTEGER,                -- rupees, null until the day is wrapped
  UNIQUE (production_id, n)
);

CREATE TABLE IF NOT EXISTS day_cast (
  day_id INTEGER NOT NULL REFERENCES shoot_days(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  PRIMARY KEY (day_id, actor_id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  no INTEGER NOT NULL,
  day_id INTEGER REFERENCES shoot_days(id) ON DELETE SET NULL,
  heading TEXT NOT NULL DEFAULT '',
  bilingual INTEGER NOT NULL DEFAULT 0,
  shot INTEGER NOT NULL DEFAULT 0,
  source_lang TEXT NOT NULL DEFAULT '',
  breakdown TEXT                      -- JSON from the script breakdown
);

CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scenes TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_role TEXT NOT NULL,
  wasted_days REAL NOT NULL DEFAULT 0,
  new_days REAL NOT NULL DEFAULT 0,
  extra INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crew (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dept TEXT NOT NULL DEFAULT '',
  wage INTEGER NOT NULL,             -- rupees per day
  upi TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS attendance (
  crew_id INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  present INTEGER NOT NULL,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL,           -- client clock, ISO; last write wins
  paid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crew_id, date)
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,
  vendor_gstin TEXT NOT NULL DEFAULT '',
  vendor_state TEXT NOT NULL,
  invoice_no TEXT NOT NULL,
  date TEXT NOT NULL,
  ledger TEXT NOT NULL,
  taxable_paise INTEGER NOT NULL,
  rate REAL NOT NULL,
  cgst_paise INTEGER NOT NULL,
  sgst_paise INTEGER NOT NULL,
  igst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (production_id, vendor, invoice_no)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_days_prod ON shoot_days(production_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_prod ON audit(production_id, at);
`;

export function openDb(file = process.env.SLATE_DB || 'data/slate.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; roll back on any error. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
