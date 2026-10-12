# 检查与任务适配

`runChecks({chapters, requirements})` 计量正文、章数、空章和重复标识，只执行本次明确要求的机械检查。它本身不调用模型，也不启动全文辅助检查。

`full15-task.mjs` 提供 `getFull15Versions`、`startFull15Review`、`resumeFull15Review` 与 `readFull15Progress`，通过包内 [Python 工具](../../creation/novel-review/README.md) 执行 C01–C06 协议。Python 3.10+ 的 `python3` 命令必须可用。稿件、要求、规则版本及模型分片在服务端配置的运行目录内冻结；浏览器不能指定运行目录。

模型调用通过注入的 `analyze` 回调执行，冷读和问题检查使用独立上下文。每阶段一次请求，返回原始 JSON 和实际传输回执；失败或结果不明不自动重复调用。恢复保留已完成阶段、失败响应及尝试关系。报告绑定提交版本，不覆盖现稿。

产品已接入保存后排队、旧稿手动检查、取消与重新检查。`no_corpus` 模式不读取资料库，C06 为 `not_evaluated`；C05 仅依据本次明确要求。公开包没有历史实验或私有小说样本。

本次更新通过合成输入的协议与工作流测试。修复版完整两阶段真实提供商复测尚未完成；工程检查通过不代表文学效果、平台审核或商业表现合格。
