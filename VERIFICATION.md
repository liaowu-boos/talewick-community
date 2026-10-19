# Public edition verification / 公开版验证

Date: 2026-10-19 (UTC+08:00). Environment: macOS arm64, Node.js 24.14.0, Python 3.14.2. CI uses Node.js 24 and Python 3.10.

| Check | Result |
| --- | --- |
| Clean dependency install from the public lockfile | Passed |
| TypeScript + Vite production build | Passed; existing bundle-size warning remains |
| Runtime, HTTP, creation, data, and validation tests | 1225 passed; 0 failed, cancelled, or skipped |
| UI state and complete independent-review view tests | 118 passed |
| Python review protocol tests | 53 passed |
| Independent-review HTTP + Postman simulation | Two single-reading stages and seven no-change comparison stages passed; idempotency and conflicting submission checked |
| Empty-library, no-key first start | Passed; sources and task lists empty, review capability available |
| Fresh browser at 1440px and 390px | Passed; no horizontal overflow, page errors, failed resources, or external requests |
| Public file boundaries and common credential patterns | Passed |

本次同步跨章事实抽取与裁定、确认问题修订与候选复查、盲评严重问题归属，以及 catalog 观察和候选分析批次。公开回归使用合成正反例和模拟模型响应，覆盖正常交接、不同轮次、歧义、引用边界恢复、失败保护及版本绑定。Postman 模拟通过实际 HTTP 客户端验证两次初读和七阶段无改动比较，九次请求均成功；未调用真实提供商。

This sync adds cross-chapter fact extraction and adjudication, confirmed-issue revision and candidate rechecking, blind-review harm attribution, catalog observations, and analysis candidate batches. Synthetic regressions cover normal handovers, distinct occurrences, ambiguity, quote-boundary recovery, failure preservation, and version binding. The real HTTP client completed two reading stages and seven no-change comparison stages against a local Postman simulation, with nine successful requests and no live-provider calls.

开发验收在一篇私有稿件中实际修复了三类事实问题，两路反序 AI 盲评倾向候选。该结果只支持本稿事实一致性改善，不证明通用检出率、文学质量全面通过或真人读者效果。抽取格式失败、待核对项和旧任务失败历史均保留。Full15 仍限于 C01–C06；独立候选复查完整接回采纳流程仍有后续工作，不自动采纳。

Development acceptance repaired three classes of factual issue in one private manuscript; both reversed-order AI readers preferred the candidate. This supports that manuscript's factual consistency, not general detection accuracy, comprehensive literary acceptance, or human-reader effects. Format failures, unresolved findings, and historical task failures remain visible. Full15 still covers only C01–C06; fully linking independent candidate rechecks into adoption remains follow-up work. Adoption is not automatic.

公开版本未复制私有原文、99份分析候选、历史运行数据或真实模型回包。跨章固定正反例为合成文本，四项私有任务回放与五项捕获响应回放未纳入公开测试；其他合成回归继续运行。六篇既有阅读示例保持原样。内置资料为空，显式 CLI 配置、公开规则、旧任务兼容及图标版本适配继续保留。修复一处测试清理顺序，等待任务持久化与服务关闭后才删除临时目录。

The public edition excludes private texts, analysis candidates, historical runs, and captured model responses. Cross-chapter fixtures are synthetic; four private-task replay tests and five captured-response replay tests are excluded from public test counts. Other synthetic regressions remain enabled. Six existing reading examples are unchanged. Empty built-in materials, explicit CLI configuration, public rules, legacy-task compatibility, and icon-version adaptations remain. One test cleanup race was fixed by closing and draining the task service before removing its temporary files.

浏览器本轮检查首次启动与 1440/390 宽度布局；新跨章和盲评交互通过运行时、HTTP 和界面状态测试覆盖，未声称完成浏览器点击式全文修订验收。固定规模的 remaining99 与 catalog probe 为实验工具，仍要求指定来源规模和用户自己的路径，不附带数据，也不保证任意库一键运行。

Browser checks cover first start and 1440/390 layouts. Runtime, HTTP, and UI-state tests cover new cross-chapter and blind-review behavior; this is not a claimed full browser-click manuscript-revision acceptance run. Fixed-size remaining99 and catalog probe tools retain explicit corpus-size assumptions and require user-supplied paths; they ship no data and are not general one-click importers.

AGPL-3.0-only and the Apache-2.0 Remix Icon 4.6.0 pin remain unchanged. See [third-party notices](THIRD_PARTY_NOTICES.md). [GitHub Actions](https://github.com/liaowu-boos/talewick-community/actions) verifies pushed commits independently.

## Reproduce / 复验

```sh
node tools/check-public.mjs
cd modules/product/talewick-gui
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:runtime
npm run test:ui
npm run test:review
```

The local model transport check is documented in [Postman instructions](tools/postman/README.md). The interface contract is [Independent Reviews OpenAPI](modules/product/talewick-gui/server/openapi/independent-reviews.openapi.yaml).
