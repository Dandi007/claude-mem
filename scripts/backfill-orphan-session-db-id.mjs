#!/usr/bin/env bun
// One-time backfill: recover session_db_id for orphaned observations/summaries
// by mining the worker logs. Every `STORING` log line records
//   sessionDbId=<immutable id> | memorySessionId=<M at write time>
// so an orphan row (memory_session_id no longer resolves) can be re-linked to
// its owning session via the historical mapping.
//
// SAFE BY DEFAULT: dry-run unless --apply. With --apply it takes a .bak copy of
// the DB first and writes inside a transaction. Only touches rows whose
// session_db_id IS NULL and whose recovered target session still exists.
//
// Usage:
//   bun scripts/backfill-orphan-session-db-id.mjs [--db PATH] [--logs DIR] [--apply]
//
// Requires migration 33 (session_db_id column) already applied to the DB.

import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes('--apply');
const DEFAULT_HOME = existsSync('/data/claude/.claude-mem') ? '/data/claude/.claude-mem' : join(homedir(), '.claude-mem');
const DB_PATH = arg('--db', join(DEFAULT_HOME, 'claude-mem.db'));
const LOGS_DIR = arg('--logs', join(DEFAULT_HOME, 'logs'));

if (!existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(1); }
if (!existsSync(LOGS_DIR)) { console.error(`logs dir not found: ${LOGS_DIR}`); process.exit(1); }

// 1) Build memory_session_id -> sessionDbId map from STORING log lines.
//    Drop any memory_session_id that maps to more than one sessionDbId (ambiguous).
const STORING_RE = /sessionDbId=(\d+) \| memorySessionId=(\S+)/g;
const seen = new Map();       // msid -> Set(sdbid)
const logFiles = readdirSync(LOGS_DIR).filter(f => /^claude-mem-\d{4}-\d{2}-\d{2}\.log$/.test(f));
for (const f of logFiles) {
  const text = readFileSync(join(LOGS_DIR, f), 'utf8');
  let m;
  while ((m = STORING_RE.exec(text)) !== null) {
    const sdbid = Number(m[1]);
    const msid = m[2];
    if (!seen.has(msid)) seen.set(msid, new Set());
    seen.get(msid).add(sdbid);
  }
}
const map = new Map();         // msid -> sdbid (unambiguous only)
let ambiguous = 0;
for (const [msid, set] of seen) {
  if (set.size === 1) map.set(msid, [...set][0]);
  else ambiguous++;
}
console.log(`[logs] scanned ${logFiles.length} files | ${seen.size} distinct msid | ${map.size} unambiguous | ${ambiguous} ambiguous (skipped)`);

const db = new Database(DB_PATH, APPLY ? { readwrite: true } : { readonly: true });

// Guard: migration 33 must be applied.
const hasCol = (db.query("PRAGMA table_info(observations)").all()).some(c => c.name === 'session_db_id');
if (!hasCol) { console.error('observations.session_db_id missing — apply migration 33 first.'); process.exit(1); }

const liveSessionIds = new Set(db.query('SELECT id FROM sdk_sessions').all().map(r => r.id));

// 2) For each table, find orphan rows (session_db_id IS NULL) and compute recoveries.
function plan(table) {
  const rows = db.query(`SELECT id, memory_session_id FROM ${table} WHERE session_db_id IS NULL`).all();
  const updates = [];
  let noLogEntry = 0, targetGone = 0;
  for (const r of rows) {
    const sdbid = map.get(r.memory_session_id);
    if (sdbid === undefined) { noLogEntry++; continue; }
    if (!liveSessionIds.has(sdbid)) { targetGone++; continue; }
    updates.push({ id: r.id, sdbid });
  }
  return { total: rows.length, updates, noLogEntry, targetGone };
}

const obsPlan = plan('observations');
const sumPlan = plan('session_summaries');
for (const [name, p] of [['observations', obsPlan], ['session_summaries', sumPlan]]) {
  console.log(`[${name}] orphans=${p.total} recoverable=${p.updates.length} noLogEntry=${p.noLogEntry} targetGone=${p.targetGone}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN (no writes). Re-run with --apply to backfill.');
  process.exit(0);
}

// 3) Apply: backup then transactional UPDATE.
const bak = `${DB_PATH}.bak-orphan-backfill-${Date.now()}`;
copyFileSync(DB_PATH, bak);
console.log(`\n[backup] ${bak}`);

for (const [table, p] of [['observations', obsPlan], ['session_summaries', sumPlan]]) {
  const stmt = db.prepare(`UPDATE ${table} SET session_db_id = ? WHERE id = ? AND session_db_id IS NULL`);
  const tx = db.transaction(updates => { for (const u of updates) stmt.run(u.sdbid, u.id); });
  tx(p.updates);
  console.log(`[${table}] backfilled ${p.updates.length} rows`);
}

const remaining = db.query('SELECT COUNT(*) AS n FROM observations WHERE session_db_id IS NULL').get().n;
console.log(`[done] observations still NULL (unrecoverable): ${remaining}`);
db.close();
