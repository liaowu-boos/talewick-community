# Public edition verification / 公开版验证

Date: 2026-10-14 (Asia/Shanghai). Environment: macOS arm64, Node.js 24.14.0, npm 11.9.0, Python 3.14.2. CI uses Node.js 24 and Python 3.10, the documented Python minimum.

| Check | Result |
| --- | --- |
| Dependency versions and lockfile | Unchanged; CI installs from the lockfile in a clean checkout |
| TypeScript + Vite production build | Passed; existing bundle-size warning remains |
| Runtime, HTTP, WebSocket, creation, reference, continuity, and review tests | 1048 passed; 0 failed, cancelled, or skipped |
| UI state tests | 100 passed; 0 failed, cancelled, or skipped |
| Python review protocol and package tests | 53 passed |
| Browser: generation and refresh | Passed |
| Browser: automatic auxiliary checks after saving | Passed with real Python adapter and synthetic model responses |
| Browser: revision proposal and explicit acceptance | Passed; previous manuscript retained |
| Browser: outdated report and manual check of the edited version | Passed |
| Browser: whole-manuscript dialog and no-change result | Passed; opening does not call a model, explicit start runs diagnosis/plan/reread, original remains unchanged |
| Browser: cancellation and same-task resume | Passed |
| Fresh entry with no key, empty library, tasks and reviews | Passed; public rule versions available |
| Fresh browser layout at 1440px and 390px | Passed; no horizontal overflow |
| Public file boundary and common credential patterns | Passed |

本轮同步包含整稿修订、跨章事件链、规划后材料采用、叙事观察处理和篇幅预算。测试使用实际本机服务、任务持久化、AI SDK 和包内 Python 工具，模型输出由合成替身提供。额外的无端口任务测试验证了新版默认模式下保留原稿、确认后修订，以及拒绝或保留不确定审稿意见的行为。
This sync includes whole-manuscript revision, cross-chapter event checks, reference decisions after planning, narrative-observation processing, and length budgeting. Tests use the actual local service, task persistence, AI SDK, and bundled Python tools with synthetic model responses. In-process task tests also exercise the new default mode without an HTTP listener, including revision after confirmation and refusal to revise rejected or uncertain findings.

本轮没有调用真实提供商，不以内部资料上的测试报告证明公开版本的文学质量。完整 Full15 未启用；独立跨章事实小单元及整稿验收接口尚未接成新的产品自动采纳门槛。浏览器整稿用例覆盖无修改路径；修改范围、跨章整项修改、显式采纳与用户编辑冲突另外由运行时和界面状态测试覆盖。六篇阅读示例保持原有内容。
This sync made no real-provider calls. Private-library reports do not establish literary quality for the public edition. The complete Full15 platform is unfinished; independent fact-check units and the separate acceptance interface do not yet gate product adoption. The browser whole-revision case covers the no-change path; runtime and UI-state tests cover edit scope, atomic cross-chapter changes, explicit acceptance, and conflicts with user edits. The six reading examples are unchanged.

公开包保留处理代码、独立公开检查规则和合成协议测试。内部资料库、派生观察包、真实分析夹具、原始模型回包和历史运行记录均未加入。跨章检查与观察窗口测试改用合成文本，原公开规则版本和来源校验保持不变。公开版内置资料继续为空，并保留显式 CLI 配置、持久化等待和浏览器模型替身。
The package contains processing code, independent public rules, and synthetic protocol fixtures. Private libraries, derived observation packages, real analysis fixtures, captured provider responses, and historical runs are excluded. Public continuity and observation-window fixtures use synthetic text. The public rule edition and its source validation are unchanged. Earlier adaptations remain: empty built-in materials, explicit CLI configuration, persistence waits, and browser model mocks.

The product retains Apache-2.0-licensed Remix Icon 4.6.0. See [third-party notices](THIRD_PARTY_NOTICES.md). This document records local verification; [GitHub Actions](https://github.com/liaowu-boos/talewick-community/actions) checks pushed commits independently.

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

Runtime and UI regression suites include temporary loopback HTTP listeners. A sandbox that prohibits local sockets cannot run those cases; do not treat a permission failure as a pass.

Browser scripts also require Playwright and a compatible Chromium installation. Set `TALEWICK_PLAYWRIGHT_MODULE` to its ESM entry and optionally `TALEWICK_BROWSER_EXECUTABLE`, then run `node scripts/agent-runtime-smoke.mjs` or `node scripts/fresh-install-smoke.mjs`. They use isolated test state. The fresh-start check uses no API key. Do not commit browser reports or runtime directories.
