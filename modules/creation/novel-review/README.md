# 单稿辅助检查 / Manuscript checks

本目录提供 C01–C06 的 Python 工具、模型提示词、公开规则与合成测试。需要 **Python 3.10+** 和标准库，终端中的 `python3` 必须可用；无须安装 Python 第三方包。内部方案、小说资料库、真实回包和历史运行目录不随包发布。

The package contains the Python tools, prompts, public rules, and synthetic tests for C01–C06. It requires Python 3.10+ on the `python3` command and only the standard library. Private plans, source novels, provider outputs, and historical runs are excluded.

| 检查 | 范围 |
| --- | --- |
| C01 | 本次明确指定的字数和章数要求 |
| C02 | 开篇指定窗口中的人物、事件、目标或风险 |
| C03 | 有明确原文证据的人物知情矛盾 |
| C04 | 有明确原文证据的物件状态矛盾 |
| C05 | 明确适用时的第四、第五章承接 |
| C06 | 明确获准参考范围内的字面重合 |

产品接入由 [任务适配器](../../validation/runtime/README.md) 和本机服务负责。新稿保存后另行排队，旧稿可手动提交固定副本，检查失败不改变已经完成的创作。产品目前使用 `no_corpus`，C06 标记未评估；C05 取决于本次明确要求。完整历史 Full15 平台不在此包范围内。

The product queues a separate review after saving a new manuscript and supports manual checks of saved drafts. Reports belong to the submitted version. The product uses `no_corpus`, so C06 is not evaluated; C05 requires explicit applicability. This package does not include the historical Full15 platform.

规则见 [公开检查规则](source-snapshots/public-check-rules.md)。`checks.json` 保存规则字段、逐字引用、行范围和内容哈希；`SOURCE_SNAPSHOTS.json` 只登记公开规则。公开规则版本与内部版本不同，不能把旧运行报告当作本包验证。冷读和问题检查使用独立上下文；没有两个有效阶段及对应回执时，不生成完成结论。

The public rules have their own hashes and version identity. Earlier private reports do not validate this package. A completed review requires two valid analysis stages and matching receipts. Completion establishes only the bounded diagnostic process, not literary quality or provider compatibility.

从仓库根目录运行机械与协议测试：

```sh
python3 -B -m unittest discover -s modules/creation/novel-review/tests
```

`python3 -B modules/creation/novel-review/review.py --help` 列出底层命令。Python 工具自身不请求模型；产品通过服务端模型配置提供回调。界面使用方法见 [项目说明](../../../README.md)。
