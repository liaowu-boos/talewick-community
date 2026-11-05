# Verification / 验证记录

## 2026-11-05 · Citation coverage and invalid review states

The public checkout passed the production build and 1,832 tests: 1,571 runtime, 123 UI, 53 Python, 69 preview and 16 continuous-review tests. The preview suite includes synthetic SSR and loopback HTTP checks. Existing locked dependencies were reused; the existing large-bundle build warning remains.

公开新增比较引文覆盖、阶段返回诊断、连续三章匿名对读离线校验和限定范围状态适配。无效响应保留原意见，有效偏好为空；引用位置与变化覆盖不会自动转成事实或文学质量通过。通用工具需要调用方显式接入，默认GUI评阅流程不变。

Only code, protocol definitions, documentation and synthetic fixtures are included. Private manuscripts, captured responses, round-specific previews, provider/accounting records and personal paths remain local. Publication verification made zero model requests. Public file boundaries and common credential patterns passed; GitHub CI also runs the new continuous-review suite.

Reproduce from the repository root after building the GUI:

```sh
node --test tools/review-preview/tests/*.test.mjs tools/continuous-review/*.test.mjs
node tools/check-public.mjs
```

## 2026-11-04 · Review delivery and compatibility

The public checkout passed the production build and 1,751 tests (1,548 runtime, 123 UI, 53 Python and 27 preview tests). The preview suite includes a synthetic SSR build, HTML escaping and loopback HTTP checks. Publication verification used local synthetic inputs and made zero model requests.

The compatibility tests run the pinned e68f56d writer against a synthetic input to generate retry and recovery records in a temporary directory. Run them from a Git clone containing that commit and with tar available. CI checks out the history. The ordinary evidence audit explicitly rejects enhanced-policy seals until it has a dedicated adapter.

公开版验证了七阶段送评证据、旧任务重放、失败引用和分来源展示。预览测试需先构建 GUI，其余复验步骤见下文。完整测试命令为 GUI 目录下的 `npm run test:runtime`、`npm run test:ui`、`npm run test:review`，以及仓库根目录下的 `node --test tools/review-preview/tests/*.test.mjs`。


## 2026-11-03 · Opt-in review evidence utilities

| Check | Result |
| --- | --- |
| TypeScript, Vite, design preview | Passed; existing large-bundle warning remains |
| Runtime / HTTP / data / validation suite | 1,533 passed; zero failures, cancellations, or skips |
| UI and state tests | 123 passed |
| Python review tests | 53 passed |
| New evidence utility regressions, included above | 9 passed; synthetic inputs only |
| Public file boundaries and common credential patterns | Passed |
| New live model calls during public release verification | 0 |

本次提取可复用的评阅证据规则、逐字差异核验和短引用定位工具。覆盖提示词与原协议分别绑定、盲读阶段不接收差异补充、标题与空白差异、Unicode/CRLF 边界、错误或歧义引用、提示词篡改，以及引用匹配不能证明断言成立。新工具需显式接入，默认 GUI 评审路径未改变；本次没有重跑人工浏览器验收，也没有以真实模型调用验证公开接入。构建和测试使用已有锁定依赖，本次未重新安装依赖。

Reusable prompt evidence rules, literal differences and short quotation verification are released as opt-in utilities. Regression coverage includes separate delivered/protocol hashes, blind-stage isolation from the difference supplement, title/whitespace changes, Unicode/CRLF boundaries, invalid or ambiguous citations, prompt drift, and the distinction between citation integrity and semantic support. The default GUI review transport is unchanged. Existing locked dependencies were reused; no fresh installation, manual browser acceptance or live-provider verification was performed for this release.

真实稿件、模型原回包、实验轮次配置、人工事实核实记录和本机路径未公开。公开版测试全部使用合成输入。测试通过、流程完成与引用定位均不代表文学质量通过。工具用法及限制见[证据工具说明](modules/validation/runtime/independent-review-evidence-policy.md)。

Private manuscripts, captured responses, local experiment configuration, manual adjudications and machine paths are excluded. Passing tests establishes software behavior, not factual interpretation or literary acceptance. See the [utility guide](modules/validation/runtime/independent-review-evidence-policy.md).

## Previous verification · 2026-11-02

2026-11-02 · Public source sync from the integrated r10 candidate.

| Check | Result |
| --- | --- |
| Locked dependency installation | Passed with npm ci |
| TypeScript, Vite, design preview | Passed; existing large-bundle warning remains |
| Runtime / HTTP / data / validation suite | 1,524 passed; zero failures, cancellations, or skips |
| UI and state tests | 123 passed |
| Python review tests | 53 passed |
| Empty-library, no-key startup | Passed in the local browser; home page renders and reports model configuration missing; no captured console warnings/errors |
| Public boundary and common credential patterns | Passed |
| Live model calls | 0 |

本次同步评语依据分批复核、原句绑定与状态展示，修订方案事实及场景依赖检查，材料上下文和失败保护。公开版独立构建与回归验证通过，不依赖迁移电脑的原路径。新模块类型声明与测试加载器已补齐；历史版本测试使用不带新策略字段的历史请求形状，生产校验未放宽。

Public changes include batched review-evidence auditing, exact-source binding and status presentation, plan fact and scene-dependency checks, adopted material context, and failure handling. New type declarations and test-loader dependencies are included. Legacy tests use historical request shapes without new policy fields; production validation was not relaxed.

七个依赖内部样本或旧快照的新测试文件、两个内部回放用例未公开。场景依赖控制改用独立合成仓库收发场景，保留原有断链阻断、整场删除、逐字证据、失败恢复和采纳约束断言。真实原文、回包及历史快照均不随测试发布。既有公开规则、空资料库、六篇阅读示例与 Remix Icon 4.6.0 许可适配保留。

Seven new test/replay files and two cases relying on private samples or historical snapshots are excluded. Scene-dependency controls use an original synthetic warehouse scene, preserving broken-chain blocking, whole-scene removal, exact evidence, recovery, and adoption assertions. Existing public rules, the empty library, six reading examples, and Remix Icon 4.6.0 remain in place.

本次没有新模型调用、文学质量盲评或完整人工浏览器修订流程验收。首次启动只验证实际默认浏览器视口，未重做指定桌面/移动宽度矩阵，也未重跑 Postman 模拟。运行时和界面测试验证程序行为；引文匹配与流程完成不代表语义准确或文学质量通过。Full15 仍限 C01–C06，采纳由作者确认。

No live model calls, literary blind reviews, full manual browser revision workflow, fixed-width responsive matrix, or Postman simulation were performed in this sync. Browser validation covers the actual default viewport. Tests establish program behavior, not semantic correctness or literary quality. Full15 remains C01–C06 and adoption remains author-controlled.

## Reproduce

From modules/product/talewick-gui:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:runtime
npm run test:ui
npm run test:review
node ../../../tools/check-public.mjs
```

[GitHub Actions](https://github.com/liaowu-boos/talewick-community/actions) independently verifies pushed commits.
