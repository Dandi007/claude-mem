/** 仅运行上游 SQLite 层；不 import worker / DatabaseManager，不发起模型或 Chroma 请求。 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const [checkout, database, reportPath] = process.argv.slice(2);
if (!checkout || !database || !reportPath) throw new Error('usage: probe-upstream.ts CHECKOUT SCRATCH_DB REPORT');
const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
if (!dataDir || !resolve(database).startsWith(resolve(dataDir) + '/')) throw new Error('DB must be inside explicit isolated CLAUDE_MEM_DATA_DIR');
if (resolve(database).startsWith('/data/claude/')) throw new Error('Production data path forbidden');

const started = performance.now();
const { SessionStore } = await import(pathToFileURL(resolve(checkout, 'src/services/sqlite/SessionStore.ts')).href);
const { SessionSearch } = await import(pathToFileURL(resolve(checkout, 'src/services/sqlite/SessionSearch.ts')).href);
const db = new Database(database);
const store = new SessionStore(db, { syncOpsEnabled: false });
const search = new SessionSearch(db);
const tables = ['observations', 'session_summaries', 'sdk_sessions', 'user_prompts'];
const report = {
  checkout: resolve(checkout), database: resolve(database), bun: Bun.version,
  durationMs: Math.round(performance.now() - started),
  counts: Object.fromEntries(tables.map(t => [t, db.query(`SELECT count(*) AS n FROM ${t}`).get()])),
  versions: db.query('SELECT version FROM schema_versions ORDER BY version').all(),
  quickCheck: db.query('PRAGMA quick_check').all(),
  foreignKeyViolations: db.query('PRAGMA foreign_key_check').all(),
  // 给真实查询层传入明确 filter，避免空查询无 filter 被上游拒绝。
  filteredObservationCount: search.searchObservations(undefined, { project: 'vault', platformSource: 'codex', limit: 100000, orderBy: 'date_desc' }).length,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, foreignKeyViolations: report.foreignKeyViolations.length }));
db.close();
