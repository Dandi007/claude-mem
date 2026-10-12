import { afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { packageRuntime } = createRequire(import.meta.url)('../../scripts/package-runtime.cjs');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-runtime-')); temporary.push(root);
  const source = join(root, 'source');
  const files: Record<string, string> = {
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'claude-mem', version: '13.29.0', skills: './skills/', mcpServers: './.mcp.json', hooks: './hooks/codex-hooks.json' }),
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'claude-mem', version: '13.29.0' }),
    '.mcp.json': JSON.stringify({ mcpServers: { 'mcp-search': { command: 'node', args: ['.codex/plugins/cache/claude-mem-local/claude-mem'] } } }),
    'package.json': '{}',
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [] } }),
    'hooks/codex-hooks.json': JSON.stringify({ hooks: { SessionStart: [], PostToolUse: [], Stop: [] } }),
    'scripts/bun-runner.js': 'runtime runner', 'scripts/worker-service.cjs': 'worker', 'scripts/mcp-server.cjs': 'mcp',
    'modes/code.json': '{}', 'sqlite/SessionStore.js': 'sqlite', 'ui/index.html': 'ui',
    'skills/do/SKILL.md': 'orchestrator', 'commands/do.md': 'command', 'agents/do.md': 'agent'
  };
  for (const [file, body] of Object.entries(files)) { const target = join(source, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, body); }
  return { root, source, output: join(root, 'release') };
}
test('独立发行包排除所有 skills，保留 hooks、MCP 与运行资产', () => {
  const { source, output } = fixture(); const plugin = packageRuntime(output, source);
  for (const dir of ['skills', 'commands', 'agents']) expect(existsSync(join(plugin, dir))).toBe(false);
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  expect(manifest.skills).toBeUndefined();
  expect(existsSync(join(plugin, manifest.mcpServers))).toBe(true);
  expect(readFileSync(join(plugin, manifest.hooks), 'utf8')).toBe(readFileSync(join(source, manifest.hooks), 'utf8'));
  for (const asset of ['scripts/mcp-server.cjs', 'modes/code.json', 'sqlite/SessionStore.js', 'ui/index.html']) expect(readFileSync(join(plugin, asset), 'utf8')).toBe(readFileSync(join(source, asset), 'utf8'));
  const market = JSON.parse(readFileSync(join(output, '.agents/plugins/marketplace.json'), 'utf8'));
  expect(join(output, market.plugins[0].source.path)).toBe(plugin);
  expect(readFileSync(join(plugin, '.mcp.json'), 'utf8')).toBe(readFileSync(join(source, '.mcp.json'), 'utf8'));
  expect(market.name).toBe('claude-mem-local');
  expect(existsSync(join(source, 'skills/do/SKILL.md'))).toBe(true);
});
test('不覆盖已有发行目录，不删除或修改源 plugin', () => {
  const { source, output } = fixture(); packageRuntime(output, source);
  expect(() => packageRuntime(output, source)).toThrow('目标已存在');
  expect(() => packageRuntime(source, source)).toThrow('目标已存在');
  expect(existsSync(join(source, 'scripts/worker-service.cjs'))).toBe(true);
});
test('缺少必要 runtime 文件时不产生发行包', () => {
  const { source, output } = fixture(); rmSync(join(source, 'scripts/mcp-server.cjs'));
  expect(() => packageRuntime(output, source)).toThrow();
  expect(existsSync(output)).toBe(false);
});
