# Observer 与 Chroma 恢复方案

## 需求与设计

用户已确认修复模型迁移遗留配置、重复启动和向量检索故障。记忆保留现有 SQLite 与 Chroma 数据，不改 embedding 模型及维度。

chroma-mcp 0.2.6 固定依赖 mcp 1.6.0，后者导入 Pydantic 私有 eval_type_backport；浮动安装的 pydantic 2.14.3 已无此函数。现有 uvx 依赖约束增加经实际启动验证的 pydantic==2.10.6，所有预热和实际进程共用约束。

本机插件重启产生独立 daemon，systemd 启动时发现健康进程并正常退出；Restart=always 导致持续重复启动。部署将正常退出策略改为 on-failure，异常退出继续自动恢复。长期由 systemd 前台进程持有 worker，操作员通过 systemctl 重启；不要混用插件 daemon 重启入口。systemd 的 observer env 同步使用 deepseek-v4.1-flash。

## 验收

运行现有 Chroma launcher、生命周期、同步测试，构建并检查发布 bundle；用真实 uvx 环境执行 --help 和隔离 Chroma 语义读写。生产要求 health ok、连续模型调用成功、Chroma deep probe 成功、systemd MainPID 与健康接口 PID 一致且重启计数稳定。

## 部署与发布条件

代码、测试、构建产物经 PR 交付。备份本机 env/drop-in 与旧 worker bundle后，安装新 bundle 和模型配置，daemon-reload 不重启 worker。若当前仍为独立 daemon，需要操作员完成一次 systemd 接管；本会话运行环境禁止助手重启 worker，因此该动作必须留给用户执行。未通过生产 deep probe 和进程托管验收不得声称完全恢复。

## 回滚

恢复本次备份的 bundle、env 和 drop-in，重新加载 systemd；保留当前数据库及向量目录，不能整库回滚覆盖新记忆。Pydantic 固定仅影响 claude-mem 的 uvx 子进程，不修改全局 Python 安装。
