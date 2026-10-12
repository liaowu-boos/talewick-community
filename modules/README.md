# 模块说明 / Modules

| 目录 | 责任 / Responsibility |
| --- | --- |
| product/talewick-gui | React 界面、本机 HTTP 服务、模型适配、任务保存 / UI, local server, provider adapters, task persistence |
| creation/runtime | 需求、规划、逐章写作、审阅与修订 / Requirements, planning, drafting, review, revision |
| data/runtime | 用户导入资料、分析、检索与来源绑定 / User-supplied materials, analysis, retrieval, provenance |
| validation/runtime | 基础检查、证据核验与独立检查任务 / Mechanical checks, evidence validation, and auxiliary review tasks |
| creation/novel-review | Python 检查工具、公开规则与合成测试 / Python review tools, public rules, and synthetic tests |
| creation/write-short-fiction-candidate/references | 创作运行时读取的流程规则 / Workflow rules loaded by the creation runtime |

数据模块包含处理代码，不含内部数据集。首次运行创建空资料库。测试使用合成输入；阅读示例独立存放在根目录 examples，不自动加载到创作流程。
The data module contains processing code, not the private dataset. A new installation creates an empty library. Tests use synthetic inputs; examples are separate reading files and are not loaded automatically.

产品层调用创作层，创作层读取规则并调用数据与验证模块。请保留目录关系。独立 Skill 历史包、实验基线、生产日志和本机发布包不在此公开版本中。
Keep this directory layout: the product imports creation, data, and validation modules. Historical standalone Skill bundles, experiment baselines, production logs, and local release bundles are excluded.
