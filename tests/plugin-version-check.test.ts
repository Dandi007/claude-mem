import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const VERSION_CHECK_SCRIPT = join(import.meta.dir, '..', 'plugin', 'scripts', 'version-check.js');

function runVersionCheck(root: string) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
  delete env.CLAUDE_MEM_CODEX_HOOK;

  return spawnSync('node', [VERSION_CHECK_SCRIPT], {
    encoding: 'utf-8',
    env,
  });
}

describe('plugin/scripts/version-check.js install marker compatibility', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `version-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ version: '12.4.4' }));
    // Pre-create node_modules so version-check's Setup-phase dependency
    // auto-install (gh #2649) short-circuits — these tests are about
    // .install-version marker compatibility, not dependency materialisation.
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a matching legacy plain-text marker without an upgrade hint', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.4\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('accepts a matching legacy plain-text marker with a leading v', () => {
    writeFileSync(join(tempDir, '.install-version'), 'v12.4.4\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('emits an upgrade hint for a mismatched legacy plain-text marker', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.3\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'claude-mem: upgraded to v12.4.4 - run: npx claude-mem@latest install',
    );
  });

  for (const [name, marker] of [
    ['缺失安装标记', undefined],
    ['安装标记损坏', '{broken'],
    ['安装版本过期', '12.4.3'],
  ] as const) {
    it(`Codex ${name}时仍执行真实 SessionStart 命令并只返回记忆 JSON`, () => {
      if (marker !== undefined) writeFileSync(join(tempDir, '.install-version'), marker);
      mkdirSync(join(tempDir, 'scripts'));
      copyFileSync(VERSION_CHECK_SCRIPT, join(tempDir, 'scripts/version-check.mjs'));
      writeFileSync(join(tempDir, 'scripts/version-check.js'),
        "import('./version-check.mjs');\n");
      writeFileSync(join(tempDir, 'scripts/worker-service.cjs'), '');
      writeFileSync(join(tempDir, 'scripts/bun-runner.js'), `
        const assert = require('node:assert/strict');
        assert.deepEqual(process.argv.slice(3), ['hook', 'codex', 'context']);
        process.stdout.write(JSON.stringify({hookSpecificOutput: {
          hookEventName: 'SessionStart', additionalContext: '已加载历史记忆'
        }}));
      `);
      const config = JSON.parse(readFileSync(join(import.meta.dir,
        '../plugin/hooks/codex-hooks.json'), 'utf-8'));
      const result = spawnSync('bash', ['-c', config.hooks.SessionStart[0].hooks[0].command], {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: tempDir },
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
          session_id: 'codex-context-regression', cwd: tempDir }),
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('claude-mem:');
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('已加载历史记忆');
    });
  }
});
