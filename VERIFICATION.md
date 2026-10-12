# Public edition verification / 公开版验证

Date: 2026-10-12 (Asia/Shanghai). Environment: macOS arm64, Node.js 24.14.0, npm 11.9.0, Python 3.14.2. CI additionally uses Python 3.10, the documented minimum.

| Check | Result |
| --- | --- |
| Dependency versions and lockfile | Unchanged; CI installs the lockfile in a clean checkout |
| TypeScript + Vite production build | Passed; existing bundle-size warning remains |
| Runtime, HTTP, reference screening, and auxiliary review tasks | 769 passed; 0 failed, cancelled, or skipped |
| UI state tests | 95 passed; 0 failed, cancelled, or skipped |
| Python review protocol and package tests | 53 passed |
| Browser: generation and refresh | Passed |
| Browser: saved manuscript automatically completes separate checks | Passed with real Python adapter and synthetic model responses |
| Browser: revision proposals and explicit acceptance | Passed |
| Browser: outdated report and manual check of the edited version | Passed; earlier report and manuscript retained |
| Browser: cancellation and same-task resume | Passed |
| Fresh production entry, no key, empty library, tasks and reviews | Passed; bundled rule versions available |
| Fresh browser layout at 1440px and 390px | Passed; no horizontal overflow |
| Public file boundary and common credential patterns | Passed |

生成、修改、恢复和辅助检查测试使用真实的本机服务、AI SDK 与包内 Python 工具，模型输出由显式合成替身提供。本次公开同步没有调用真实提供商。修复版完整两阶段真实模型复测尚未完成；测试不证明文学质量或所有模型兼容性。六篇阅读示例保持原有内容，不是本次生成结果。
Generation, revision, recovery, and auxiliary review tests use the real local service, AI SDK, and bundled Python tools with explicit synthetic model responses. This public sync made no real-provider calls. A complete real-provider rerun of the repaired two-stage review is still pending. These tests establish engineering behavior, not literary quality or universal model compatibility. The six earlier reading examples are unchanged.

公开包只保留处理代码、独立公开检查规则和合成协议测试。内部资料库、派生观察、原始模型回包、真实小说 JSON 夹具、内部方案和历史运行记录均未加入。`checks.json` 中的引用和哈希绑定公开规则；公开规则版本与内部历史版本不同，不能复用内部报告宣称本包已验收。
The package includes processing code, independent public rules, and synthetic protocol fixtures. Private libraries, derived observations, captured provider output, real-manuscript JSON fixtures, internal plans, and historical runs are excluded. Rule excerpts and hashes bind the public rules; their version differs from the private historical package, so private reports do not validate this edition.

保留此前公开版的持久化等待、显式浏览器模型替身、空内置资料与可配置 CLI 路径。章号回归用合成十章正文验证；Python 命令行测试在独立复制的包中执行，避免依赖工作目录和既有缓存。未弱化生产校验。
Earlier public adaptations remain: persistence waits, explicit browser model mocks, no bundled private materials, and a configurable CLI path. Chapter serialization uses synthetic ten-chapter manuscripts. Python CLI checks run from an independently copied package rather than relying on the working directory or existing caches. Production validation was not weakened.

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

Browser scripts also require Playwright and a compatible Chromium installation. Set `TALEWICK_PLAYWRIGHT_MODULE` to its ESM entry and optionally `TALEWICK_BROWSER_EXECUTABLE`, then run `node scripts/agent-runtime-smoke.mjs` or `node scripts/fresh-install-smoke.mjs`. They use isolated test state. The fresh-start check uses no API key. Do not commit browser reports or runtime directories.
