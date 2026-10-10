# Public edition verification / 公开版验证

Date: 2026-10-10 (Asia/Shanghai). Environment: macOS arm64, Node.js 24.14.0, npm 11.9.0.

| Check | Result |
| --- | --- |
| Clean dependency installation in the public checkout | Passed using the lockfile; install scripts disabled |
| TypeScript + Vite production build | Passed; bundle-size warning remains |
| Runtime, HTTP, and reference screening tests | 694 passed; 0 failed, cancelled, or skipped |
| UI state tests | 95 passed; 0 failed, cancelled, or skipped |
| Browser: generation and refresh | Passed |
| Browser: revision proposals and explicit acceptance | Passed |
| Browser: cancellation and same-task resume | Passed |
| Fresh production entry, no key, empty library and tasks | Passed |
| Fresh browser layout at 1440px and 390px | Passed; no horizontal overflow |
| Public file boundary and common credential patterns | Passed |

生成、修改和恢复测试使用真实的本机服务与 AI SDK，但模型响应由显式测试替身提供。本次没有调用真实提供商生成新作品；不以测试通过承诺文学质量或所有模型兼容性。六篇阅读示例来自先前已完成的创作与修订，不属于本次测试结果。
Generation, revision, and recovery tests use the real local service and AI SDK with explicit mock model responses. No new story was generated through a real provider during these checks. They establish workflow behavior, not literary quality or universal provider compatibility. Reading examples came from earlier completed runs.

公开版没有内部资料库及其派生静态材料。一个依赖私有历史基线的独立对照测试没有纳入公开包；本次审稿 JSON 恢复测试使用合成响应，未复制真实模型回包。浏览器替身已支持新增状态审阅，资料筛选集成测试同时验证恢复成功与恢复失败，持久化检查等待写入结束。批量测试在临时目录运行。未弱化生产校验以迎合测试。
The public edition excludes the private library and its derived static materials. One historical comparison test requiring a private baseline is excluded. Review JSON recovery uses a synthetic response instead of captured private model output. Browser fixtures support state review, screening integration checks both successful and failed recovery, and persistence checks wait for disk writes to finish. Batch tests use temporary storage. Production validation was not weakened to satisfy tests.

The product pins Apache-2.0-licensed Remix Icon 4.6.0. Third-party notices are in THIRD_PARTY_NOTICES.md. This table records local verification; [GitHub Actions](https://github.com/liaowu-boos/talewick-community/actions) independently checks each pushed commit.

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
