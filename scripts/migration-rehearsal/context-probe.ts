/** 只读历史表，验证上游 context 查询与真实 renderer；不启动 worker。 */
import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'node:path';
import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [checkout, database, reportPath] = process.argv.slice(2);
if (!checkout || !database || !reportPath) throw new Error('usage: context-probe.ts CHECKOUT SCRATCH_DB REPORT');
const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!dataDir || !configDir || !realpathSync(database).startsWith(realpathSync(dataDir) + '/') || realpathSync(database).startsWith('/data/claude/')) throw new Error('Isolated database required');
if (!resolve(configDir).startsWith(resolve(dataDir) + '/') || resolve(dirname(reportPath)) !== resolve(dataDir)) throw new Error('Config/report must be isolated');
process.env.CLAUDE_MEM_MODES_DIR = resolve(checkout, 'plugin/modes');
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in context rehearsal'); };
const load = (path: string) => import(pathToFileURL(resolve(checkout, path)).href);
const { ModeManager } = await load('src/services/domain/ModeManager.ts');
ModeManager.getInstance().loadMode('code');
const { loadContextConfig } = await load('src/services/context/ContextConfigLoader.ts');
const { queryObservationsMulti, querySummariesMulti } = await load('src/services/context/ObservationCompiler.ts');
const { renderContextFromRows } = await load('src/services/context/ContextBuilder.ts');
const config = loadContextConfig();
// 默认 false，明确禁止从宿主 transcript 读上一条消息。
config.showLastMessage = false;
const db = new Database(database, { readonly: true, create: false });
db.run('PRAGMA query_only=ON');
const report: any = { status: 'running', readonly: true, platforms: {} };
try {
  for (const platform of ['claude', 'codex']) {
    const observations = queryObservationsMulti({ db }, ['vault'], config, platform);
    const summaries = querySummariesMulti({ db }, ['vault'], config, platform);
    assert(observations.length > 0 && summaries.length > 0);
    for (const [table, rows] of [['observations', observations], ['session_summaries', summaries]] as const) {
      for (const row of rows) {
        const owner = db.query(`SELECT s.platform_source AS platform, c.project, c.merged_into_project AS merged FROM ${table} c JOIN sdk_sessions s ON s.memory_session_id=c.memory_session_id WHERE c.id=?`).get(row.id) as any;
        assert.equal(owner.platform, platform);
        assert(owner.project?.toLowerCase() === 'vault' || owner.merged?.toLowerCase() === 'vault');
      }
    }
    const rendered = renderContextFromRows({ observations, summaries }, { includeHealthWarning: false, platformSource: platform }, false, { config, cwd: resolve(dataDir, 'workspace'), project: 'vault' });
    assert(rendered.text.length > 0 && rendered.text.length <= 10000);
    const observationRefs = [...rendered.text.matchAll(/^(\d+)\s/gm)].map(match => Number(match[1]));
    const summaryRefs = [...rendered.text.matchAll(/^S(\d+)\s/gm)].map(match => Number(match[1]));
    assert(observationRefs.length > 0, 'Rendered observation references required');
    const observationIds = new Set(observations.map((row: any) => row.id));
    const summaryIds = new Set(summaries.map((row: any) => row.id));
    assert(observationRefs.every(id => observationIds.has(id)));
    assert(summaryRefs.every(id => summaryIds.has(id)));
    report.platforms[platform] = { queriedObservations: observations.length, queriedSummaries: summaries.length, renderedCharacters: rendered.text.length, observationReferenceCount: observationRefs.length, summaryReferenceCount: summaryRefs.length, referencesAndOwnershipValid: true, stats: rendered.stats };
  }
  assert.equal(networkAttempts, 0);
  report.networkAttempts = networkAttempts;
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
