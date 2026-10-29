# Public edition verification / 公开版验证

Date: 2026-10-29 (UTC+08:00). Environment: macOS arm64, Node.js 24.14.0, Python 3.14.2. CI uses Node.js 24 and Python 3.10.

| Check | Result |
| --- | --- |
| Clean dependency install from the public lockfile | Passed |
| TypeScript + Vite production build | Passed; existing bundle-size warning remains |
| Runtime, HTTP, creation, data, and validation tests | 1383 passed; 0 failed, cancelled, or skipped |
| UI state and complete independent-review view tests | 123 passed |
| Python review protocol tests | 53 passed |
| Independent-review HTTP + Postman simulation | Two single-reading stages and seven no-change comparison stages passed; idempotency and conflicting submission checked |
| Empty-library, no-key first start | Passed; sources and task lists empty, review capability available |
| Fresh browser at 1440px and 390px | Passed; no horizontal overflow, page errors, failed resources, or external requests |
| Public file boundaries and common credential patterns | Passed |

本次同步写作目标与采用证据、候选复查与本地稿件找回、聚焦阅读协议、段落引用、失败恢复和本地文件可用性保护。公开回归全部使用合成数据；新增流程覆盖身份冲突、版本不一致、恢复边界及失败保护。原生 DeepSeek 默认低推理设置通过本地真实 HTTP 和 SDK 序列化验证，阶段特例保持不变。

This sync adds writing goals and adoption evidence, candidate rechecking and local manuscript recovery, focused review, paragraph references, failure recovery, and local-file availability guards. Public regressions use synthetic data, including identity conflicts, stale versions, recovery boundaries, and failure preservation. Local HTTP and SDK serialization tests verify the native DeepSeek low-reasoning default and stage-specific exceptions.

Postman 本地模拟完成两次初读和七阶段无改动比较，九次 HTTP 请求均成功；另验证重复提交和身份冲突。未调用真实或付费模型。浏览器检查覆盖空库、无密钥首次启动、1440/390 宽度布局，无页面错误、失败资源、外部请求或横向溢出。新工作流通过运行时、HTTP 和界面状态测试验证，本轮未进行完整浏览器点击式整稿修订验收。

The local Postman simulation completed two reading stages and seven no-change comparison stages over nine successful HTTP requests, plus submission deduplication and conflict checks. No live or paid models were called. Browser checks cover an empty library, unconfigured first start, and 1440/390 layouts without page errors, failed resources, external requests, or horizontal overflow. Runtime, HTTP, and UI-state tests cover new workflows; this run does not claim full browser-click manuscript-revision acceptance.

本次以已交付 r11 为来源，未纳入后续尚未验收完成的材料场景候选版。开发验收未达到两篇稿件的全部写作目标；合成测试不能证明文学质量、通用检出率或真人读者效果。Full15 仍限于 C01–C06，聚焦六项阅读协议是另一个可选入口。采纳仍由作者确认。

The source is the delivered r11 snapshot; the later, incompletely accepted material-scene candidate is excluded. Development acceptance did not meet all writing goals for either manuscript. Synthetic tests do not establish literary quality, general detection accuracy, or human-reader effects. Full15 remains C01–C06; the focused six-dimension protocol is a separate optional entry. Adoption remains author-controlled.

未复制私有原文、分析样本、真实任务或模型回包。依赖这些数据的回放测试未纳入公开测试数；写作目标和展示测试改用合成输入。六篇既有阅读示例、空内置材料库、公共规则与旧任务兼容保留。深层参考接口需要用户自己的已验证安装；remaining99 等实验工具仍有明确的规模假设，不是任意资料库的一键导入器。

Private texts, analysis samples, historical tasks, and captured responses are excluded. Replay tests depending on those files are outside the public counts; writing-goal and display tests use synthetic inputs. The six approved reading examples, empty built-in library, public rules, and legacy-task compatibility remain. Deep references require a verified user-owned installation; experimental remaining99 tools retain corpus-size assumptions and are not universal one-click importers.

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
