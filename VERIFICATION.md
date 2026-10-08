# Public edition verification / 公开版验证

Date: 2026-10-08 (Asia/Shanghai). Environment: macOS arm64, Node.js 24.14.0, npm 11.9.0.

| Check | Result |
| --- | --- |
| Dependency installation in an isolated directory | Passed using the lockfile; install scripts disabled |
| TypeScript + Vite production build | Passed; bundle-size warning remains |
| Runtime and HTTP tests | 644 passed; 0 failed, cancelled, or skipped |
| UI state tests | 95 passed; 0 failed, cancelled, or skipped |
| Browser: generation and refresh | Passed |
| Browser: revision proposals and explicit acceptance | Passed |
| Browser: cancellation and same-task resume | Passed |
| Fresh production entry, no key, empty library and tasks | Passed |
| Fresh browser layout at 1440px and 390px | Passed; no horizontal overflow |
| Public file boundary and common credential patterns | Passed |

生成、修改和恢复测试使用真实的本机服务与 AI SDK，但模型响应由显式测试替身提供。本次没有调用真实提供商生成新作品；不以测试通过承诺文学质量或所有模型兼容性。四篇阅读示例来自先前已完成的创作，不属于本次测试结果。
Generation, revision, and recovery tests use the real local service and AI SDK with explicit mock model responses. No new story was generated through a real provider during these checks. They establish workflow behavior, not literary quality or universal provider compatibility. Reading examples came from earlier completed runs.

公开版没有内部资料库及其派生静态材料。一个依赖私有历史基线的独立对照测试没有纳入公开包；其他测试的旧替身已对齐当前局部修订和证据编号协议，批量测试改在临时目录运行。未弱化生产校验以迎合测试。
The public edition excludes the private library and its derived static materials. One historical comparison test requiring a private baseline is excluded. Other old fixtures were updated to the current bounded-revision and evidence-ID protocols; batch tests use temporary storage. Production validation was not weakened to satisfy tests.

The product pins Apache-2.0-licensed Remix Icon 4.6.0. Third-party notices are in THIRD_PARTY_NOTICES.md. The GitHub workflow has been provided but its remote execution is not part of this local verification.

## Reproduce / 复验

```sh
node tools/check-public.mjs
cd modules/product/talewick-gui
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:runtime
npm run test:ui
```

Browser scripts additionally require Playwright and a compatible Chromium installation. Set `TALEWICK_PLAYWRIGHT_MODULE` to the absolute path of its ESM entry and optionally `TALEWICK_BROWSER_EXECUTABLE`, then run `node scripts/agent-runtime-smoke.mjs` or `node scripts/fresh-install-smoke.mjs`. They create isolated test state. The fresh-install check does not use an API key. Do not commit local browser reports or runtime directories.
