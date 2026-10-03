/** 隔离副本上的真实上游 SQLite API 验证；不会启动 worker 或 embedding。 */
import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync, realpathSync } from 'node:fs';
import assert from 'node:assert/strict';

const [checkout, database, reportPath] = process.argv.slice(2);
if (!checkout || !database || !reportPath) throw new Error('usage: behavior-probe.ts CHECKOUT SCRATCH_DB REPORT');
const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!dataDir || !configDir || !realpathSync(database).startsWith(realpathSync(dataDir) + '/')) throw new Error('Explicit isolated data/config directories required');
if (realpathSync(database).startsWith('/data/claude/')) throw new Error('Production path forbidden');
if (!resolve(configDir).startsWith(resolve(dataDir) + '/') || resolve(dirname(reportPath)) !== resolve(dataDir)) throw new Error('Config/report must be isolated');

const { SessionStore } = await import(pathToFileURL(resolve(checkout, 'src/services/sqlite/SessionStore.ts')).href);
const { SessionSearch } = await import(pathToFileURL(resolve(checkout, 'src/services/sqlite/SessionSearch.ts')).href);
const { DEFAULT_PLATFORM_SOURCE } = await import(pathToFileURL(resolve(checkout, 'src/shared/platform-source.ts')).href);
const db = new Database(database);
const store = new SessionStore(db, { syncOpsEnabled: false });
const search = new SessionSearch(db);
const report: any = { status: 'running', historical: {}, fts: {}, writes: {}, networkCalls: 0 };
const ids = (rows: any[]) => rows.map(row => row.id).sort((a, b) => a - b);
try {
  for (const [table, searchMethod, getMethod] of [
    ['observations', 'searchObservations', 'getObservationsByIds'],
    ['session_summaries', 'searchSessions', 'getSessionSummariesByIds'],
  ]) {
    const expected = db.query(`SELECT c.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platform FROM ${table} c JOIN sdk_sessions s ON c.memory_session_id=s.memory_session_id`).all(DEFAULT_PLATFORM_SOURCE) as any[];
    const total = (db.query(`SELECT count(*) AS n FROM ${table}`).get() as any).n;
    assert.equal(expected.length, total, 'All historical rows must resolve a parent');
    const groups = new Map<string, number[]>();
    for (const row of expected) {
      if (!groups.has(row.platform)) groups.set(row.platform, []);
      groups.get(row.platform)!.push(row.id);
    }
    report.historical[table] = { total, platforms: {} };
    for (const [platform, expectedIds] of groups) {
      const actual = search[searchMethod](undefined, { platformSource: platform, limit: total + 1, orderBy: 'date_desc' });
      assert.deepEqual(ids(actual), expectedIds.sort((a, b) => a - b), `${table} platform search`);
      let recalled = 0;
      for (let start = 0; start < expectedIds.length; start += 500) {
        const batch = expectedIds.slice(start, start + 500);
        const found = store[getMethod](batch, { platformSource: platform });
        assert.deepEqual(ids(found), batch, `${table} batch ID recall`);
        recalled += found.length;
      }
      const page = search[searchMethod](undefined, { platformSource: platform, limit: 100, offset: 100, orderBy: 'date_desc' });
      assert.deepEqual(page.map((r: any) => r.id), actual.slice(100, 200).map((r: any) => r.id), `${table} pagination`);
      report.historical[table].platforms[platform] = { search: actual.length, recalled, pagination: true };
    }
  }
  // 诊断旧 prompt 缺失 stable ID；仅在本行为副本做无歧义回填并对照实际 API。
  const promptExpected = db.query(`SELECT p.id, s.id AS owner, COALESCE(NULLIF(s.platform_source, ''), ?) AS platform
    FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id
    UNION ALL
    SELECT p.id, s.id AS owner, COALESCE(NULLIF(s.platform_source, ''), ?) AS platform
    FROM user_prompts p JOIN sdk_sessions s ON p.content_session_id=s.content_session_id WHERE p.session_db_id IS NULL`).all(DEFAULT_PLATFORM_SOURCE, DEFAULT_PLATFORM_SOURCE) as any[];
  const promptCount = (db.query('SELECT count(*) AS n FROM user_prompts').get() as any).n;
  assert.equal(promptExpected.length, promptCount);
  assert.equal(new Set(promptExpected.map(r => r.id)).size, promptCount, 'Prompt owner must be unique');
  const promptPlatforms = [...new Set(promptExpected.map(r => r.platform))];
  const beforeCounts = Object.fromEntries(promptPlatforms.map(platform => [platform, search.searchUserPrompts(undefined, { platformSource: platform, limit: promptCount + 1 }).length]));
  const repair = db.query(`UPDATE user_prompts SET session_db_id=(SELECT id FROM sdk_sessions s WHERE s.content_session_id=user_prompts.content_session_id)
    WHERE session_db_id IS NULL AND (SELECT count(*) FROM sdk_sessions s WHERE s.content_session_id=user_prompts.content_session_id)=1`).run();
  const afterCounts: Record<string, number> = {};
  for (const platform of promptPlatforms) {
    const expectedIds = promptExpected.filter(r => r.platform === platform).map(r => r.id).sort((a, b) => a - b);
    const found = search.searchUserPrompts(undefined, { platformSource: platform, limit: promptCount + 1, orderBy: 'date_desc' });
    assert.deepEqual(ids(found), expectedIds, 'Prompt source search after repair');
    const page = search.searchUserPrompts(undefined, { platformSource: platform, limit: 100, offset: 100, orderBy: 'date_desc' });
    assert.deepEqual(page.map((r: any) => r.id), found.slice(100, 200).map((r: any) => r.id));
    afterCounts[platform] = found.length;
  }
  report.historical.user_prompts = { total: promptCount, beforeCounts, scratchRepairRows: repair.changes, afterCounts, pagination: true };
  for (const table of ['observations_fts', 'session_summaries_fts']) {
    db.run(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
    report.fts[table] = 'integrity-check passed';
  }
  report.fts.historicalTextQueries = {};
  for (const query of ['claude', '迁移']) {
    const observations = search.searchObservations(query, { limit: 100000 });
    const summaries = search.searchSessions(query, { limit: 100000 });
    assert(observations.length > 0 && summaries.length > 0, 'Historical English/Chinese search must return records');
    report.fts.historicalTextQueries[query] = { observations: observations.length, summaries: summaries.length };
  }
  const token = 'rehearsal' + Date.now();
  const project = '__migration_rehearsal__';
  const firstKey = token + '-memory-a';
  const secondKey = token + '-memory-b';
  const sessionId = store.createSDKSession(token, project, token, undefined, 'codex');
  store.updateMemorySessionId(sessionId, firstKey);
  const observation = store.storeObservation(firstKey, project, {
    type: 'discovery', title: token, subtitle: null, facts: ['synthetic'], narrative: token,
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  });
  const summary = store.storeSummary(firstKey, project, {
    request: token, investigated: token, learned: token, completed: token, next_steps: token, notes: null,
  });
  store.updateMemorySessionId(sessionId, secondKey);
  for (const [table, id, method] of [
    ['observations', observation.id, 'getObservationsByIds'],
    ['session_summaries', summary.id, 'getSessionSummariesByIds'],
  ] as const) {
    const row = db.query(`SELECT memory_session_id FROM ${table} WHERE id=?`).get(id) as any;
    assert.equal(row.memory_session_id, secondKey, `${table} FK cascade`);
    assert.equal(store[method]([id], { platformSource: 'codex', project }).length, 1);
    assert.equal(store[method]([id], { platformSource: 'claude', project }).length, 0);
  }
  assert(search.searchObservations(token, { platformSource: 'codex', project }).some((r: any) => r.id === observation.id));
  assert(search.searchSessions(token, { platformSource: 'codex', project }).some((r: any) => r.id === summary.id));
  report.writes = { sessionCreated: true, observationCreated: true, summaryCreated: true, parentKeyCascade: true, sourceIsolation: true, newRecordsTextSearchable: true };
  assert.equal(db.query('PRAGMA foreign_key_check').all().length, 0);
  assert.deepEqual(db.query('PRAGMA quick_check').all(), [{ quick_check: 'ok' }]);
  report.foreignKeyViolations = 0;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? { name: error.name, message: error.message.split('\n')[0] } : String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  db.close();
}
