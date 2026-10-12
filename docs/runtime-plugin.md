# 独立 runtime plugin

`claude-mem@claude-mem-local` 的 runtime 发行包只提供现有 MCP 和采集/注入 hooks，不包含 skills、commands 或 agents。记忆操作由独立的 `memory:create` / `memory:search` skills 指导。完整 claude-mem plugin 仍可单独发行；同一客户端只启用其中一种，避免重复采集与注入。

## 生成与安装

在已有构建产物的源码 checkout 中执行，目标必须是尚不存在的目录。

```bash
node scripts/package-runtime.cjs /data/services/agent-plugins/claude-mem-runtime-13.29.0
codex plugin marketplace add /data/services/agent-plugins/claude-mem-runtime-13.29.0
codex plugin add claude-mem@claude-mem-local
```

可用第二个参数指定已经安装并验证过的同版本 plugin 根目录。脚本复制运行资产、保留 hook 定义，生成 Claude Code / Codex manifests 和本地 marketplace。它不改原包、cache、客户端配置、数据库或运行中的 worker。更新版本时生成新目录，再更新 marketplace 并安装。

Codex runtime marketplace 沿用 `claude-mem-local` 名称。已注册 Git marketplace 时先将该来源切换为生成目录，再安装同一 plugin 身份；同一身份与 cache 路径、未改变的 hook 定义可沿用已有信任。用 hooks/list 核对实际 hash 与 trustStatus；变化或未信任的 hook 仍须完成客户端信任流程，不能复制不匹配的旧 hash。Claude Code 的 runtime marketplace 为 `claude-mem-runtime`，安装后确认运行能力再停用旧包。新开 session 检查 skills 列表与采集/注入。回退 Codex 时恢复原 marketplace Git 来源与 ref 并重新安装完整包；每类 hook 只保留一个采集来源。

新包继续使用原 worker、配置和存储。MCP 配置原样复制，Codex 的安装身份和 cache fallback 保持一致。runtime 的 hook 内容与来源包保持一致；独立发行不要求重新构建 worker 或迁移数据。

打包验证使用 `bun test tests/infrastructure/runtime-package.test.ts`，只写临时目录。
