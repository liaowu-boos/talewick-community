# Verification / 验证记录

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
