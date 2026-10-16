# Public edition verification / 公开版验证

Date: 2026-10-16 (UTC+08:00). Environment: macOS arm64, Node.js 24.14.0, Python 3.14.2. CI uses Node.js 24 and Python 3.10.

| Check | Result |
| --- | --- |
| Clean dependency install from the public lockfile | Passed |
| TypeScript + Vite production build | Passed; existing bundle-size warning remains |
| Runtime, HTTP, creation, data, and validation tests | 1171 passed; 0 failed, cancelled, or skipped |
| UI state and complete independent-review view tests | 109 passed |
| Python review protocol tests | 53 passed |
| Independent-review HTTP + Postman simulation | Two single-reading stages and seven no-change comparison stages passed; idempotency and conflicting submission checked |
| Empty-library, no-key first start | Passed; sources and task lists empty, review capability available |
| Fresh browser at 1440px and 390px | Passed; no horizontal overflow, page errors, failed resources, or external requests |
| Public file boundaries and common credential patterns | Passed |

本次同步包括 10 月 15–16 日的整稿质量模式、独立全文评阅、七阶段盲评、材料适用性及云文件等待保护。测试运行公开版实际服务和协议代码，模型输出来自合成替身；Postman 模拟经实际模型 HTTP 客户端运行。九个阶段的模拟请求已在本地日志中核对，日志不公开。本次发布没有新增真实模型调用。

This sync includes October 15–16 whole-manuscript quality revision, independent reading, seven-stage comparison, material applicability, and cloud-file waiting states. Tests run the public implementation with synthetic model outputs. The Postman check uses the real model HTTP client; nine stage requests were verified in local simulation logs. Logs are not published. This release verification made no real-provider calls.

**完成检查不代表文学合格。** 开发验收仍有同稿诊断不稳定和无修改候选，未证明质量提升。Full15 仍限于 C01–C06；分歧、无改动、目标未实现与旧版本报告均须保留。浏览器本轮验证首次启动和布局；新评阅链路由 HTTP 集成及界面状态测试覆盖，未声称完成浏览器点击式七阶段验收。

**Completed checks do not certify literary quality.** Development acceptance still found inconsistent diagnoses and unchanged candidates; quality improvement remains unproven. Full15 is limited to C01–C06. Disagreements, no-change outcomes, unmet goals, and stale reports remain visible. This round's browser check covers first start and layout; the new review workflow is covered by HTTP integration and UI-state tests, not a claimed seven-stage browser-click acceptance run.

公开包不包含私有原文库、分析数据、真实回包、历史任务或内部规则快照。失败恢复夹具通过合成输入现场生成。六篇既有阅读示例保持不变；内置资料为空。补齐测试模型的新规划字段，并修复最早版本任务缺少 baseRevision 时的只读兼容：仅允许无引擎版本的旧记录从已校验请求恢复该字段，现代记录仍严格校验。

The package excludes private source libraries, analysis datasets, captured provider outputs, historical tasks, and internal rule snapshots. Failure-recovery fixtures are generated from synthetic inputs. Existing reading examples and the empty built-in corpus are preserved. Test model responses now include required choice-causality fields. Earliest task records missing baseRevision recover that projection from their validated request without rewriting saved files; modern records retain strict binding checks.

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
