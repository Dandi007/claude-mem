# claude-mem 上游迁移演练工具

这组工具用于在隔离副本上验证本地 stable session 关联能否转换为上游 natural key，并验证历史检索；不安装插件、不启动 worker、不切换线上数据。

## 使用顺序

1. 用 SQLite backup API 制作一致备份，保留旧代码版本、settings、hooks 和 Chroma 目录。生产切换前应暂停写入，再取得同一时间点的 SQLite 与 Chroma 备份。
2. `python repair-lineage.py BASELINE_DB NEW_SCRATCH_DB` 创建新副本，修复 observation / summary 的 natural key、对应 content hash，补齐 prompt 的 stable ID。遇到冲突、歧义或剩余 FK 违规立即失败。输出的 lineage ledger 含内部标识，必须留在私有目录。
3. 设置 `CLAUDE_MEM_DATA_DIR` 为副本目录，`CLAUDE_CONFIG_DIR` 为该目录下的独立路径，再运行 `bun --no-install probe-upstream.ts UPSTREAM_CHECKOUT SCRATCH_DB REPORT_JSON`。工具调用真实 SessionStore migration 和 SessionSearch，不加载 worker。
4. `python compare-snapshots.py BASELINE_DB MIGRATED_DB --report PRIVATE_REPORT_JSON` 逐字段比较所有历史行，报告有意变更的列。上游 schema 49 会规范化 concepts，应把原值独立归档；不能把所有字段都说成原样保留。
5. 在迁移后数据库的另一个可丢弃副本上运行 `behavior-probe.ts`，参数与 probe-upstream 相同。它会做 prompt 修复对照，并写入合成测试记录，验证全量召回、分页、FTS、新增记录及 FK cascade。不要把此副本用于正式切换。
6. 在新副本重复运行修复及 migration，再比较两份迁移后数据，验收幂等性。用旧代码打开原始备份演练回滚；禁止用旧代码直接打开升级后的唯一数据库。

`context-probe.ts` 用只读数据库调用实际 query/renderer，并阻断 fetch；参数与 probe-upstream 相同。当前三个查询 probe 使用现场项目名 `vault`，复用于其他数据集前应改为对应项目。

`python worker-smoke.py UPSTREAM_CHECKOUT MIGRATED_DB NEW_RUN_DIR [INSTALLED_ZOD_DIR]` 用 bwrap 独立 PID/网络启动现有 bundle 并执行 HTTP 检索和 context smoke。要求 Linux+bwrap，plugin 依赖可由指定的同版本 zod 目录复制至 scratch。它关闭 Chroma/cloud/模型请求，不验证真实 observer。

## Chroma 验证边界

`chroma-probe.py` 是本次现场的演练驱动，采用 `baseline/` 与 `runs/repaired/` 目录约定；运行前必须阅读参数和路径保护。它只在 clone 上更新 metadata，以逐文档摘要证明 IDs、正文和向量不变，并用已有向量离线查询。缺失索引需另外补建，metadata 更新不会自动补 embedding。热拷贝前后文件 stat 一致只说明本轮未观察到变化，不能替代停写一致性快照。

## 验收标准

历史 ID 数量不减少；正文、facts、summary、prompt 文本不变；允许变更的归属字段有私有 ledger；归属无歧义；FK 与 FTS 检查通过；分平台及按 ID 召回完整；Chroma 原有文档和向量不变。worker 启动、真实 observer 模型、宿主 hooks 与 context 注入需要单独集成验收，SQLite 层通过不代表已经上线验收。

数据库、配置凭据、lineage ledger、原始内容归档和运行报告都不得加入 Git。
