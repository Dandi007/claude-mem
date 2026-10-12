#!/usr/bin/env node
// 生成只含 MCP/hooks 的本地发行包；不修改完整 plugin 或已安装 cache。
const fs = require('node:fs');
const path = require('node:path');

function packageRuntime(output, source = path.resolve(__dirname, '../plugin')) {
  output = path.resolve(output);
  source = path.resolve(source);
  const required = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json', 'package.json', 'hooks/hooks.json', 'hooks/codex-hooks.json', 'scripts/bun-runner.js', 'scripts/worker-service.cjs', 'scripts/mcp-server.cjs'];
  for (const file of required) {
    if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`缺少 runtime 文件：${file}`);
  }
  if (fs.existsSync(output)) throw new Error(`目标已存在，请选择新的发行目录：${output}`);
  if (output.startsWith(source + path.sep)) throw new Error('发行目录不能位于源 plugin 内');
  const plugin = path.join(output, 'plugin');
  fs.mkdirSync(plugin, { recursive: true });
  try {
    // 白名单排除 skills/commands/agents，同时保留现有运行资产。
    for (const entry of ['.codex-plugin', '.claude-plugin', '.mcp.json', 'package.json', 'bun.lock', 'hooks', 'scripts', 'modes', 'sqlite', 'ui']) {
      const from = path.join(source, entry);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(plugin, entry), { recursive: true, dereference: true });
    }
    for (const kind of ['.codex-plugin', '.claude-plugin']) {
      const file = path.join(plugin, kind, 'plugin.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete manifest.skills;
      delete manifest.commands;
      delete manifest.agents;
      manifest.description = 'claude-mem 的独立 MCP 与采集/注入 hooks；不包含 skills。';
      if (manifest.interface) {
        manifest.interface.shortDescription = manifest.description;
        manifest.interface.longDescription = manifest.description;
        delete manifest.interface.defaultPrompt;
      }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    }
    const version = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8')).version;
    const markets = {
      '.agents/plugins/marketplace.json': { name: 'claude-mem-local', plugins: [{ name: 'claude-mem', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] },
      '.claude-plugin/marketplace.json': { name: 'claude-mem-runtime', owner: { name: 'Dandi007' }, plugins: [{ name: 'claude-mem', version, source: './plugin', description: 'MCP 与 hooks runtime，不包含 skills。' }] }
    };
    for (const [relative, data] of Object.entries(markets)) {
      const file = path.join(output, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    }
    return plugin;
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { packageRuntime };
if (require.main === module) {
  if (!process.argv[2] || process.argv.length > 4) {
    console.error('用法：node scripts/package-runtime.cjs <新发行目录> [源 plugin 目录]');
    process.exitCode = 1;
  } else {
    try { console.log(packageRuntime(process.argv[2], process.argv[3])); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
