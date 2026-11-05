# 限定范围阅读状态适配器

`src/scoped-review.mjs` 将 `tools/continuous-review` 的离线校验结果转为展示状态。它不发送请求，也不修改原始响应。

```js
import {scopedReaders} from './src/scoped-review.mjs';
const readers = scopedReaders({manifest, get, ref, manuscripts, planned});
```

`manuscripts` 和 `planned` 使用 continuous-review 的稿件及 `buildReadingPrompts` 结果。调用者负责冻结匿名版本映射与实际消息摘要。`get`、`ref` 来自经过摘要核对的 evidence store；传入的 `manifest` 是调用者冻结的阅读配置：

```js
{
  executionId: 'execution', // 可缺省
  readers: [
    {id: 'reader-1', order: ['A', 'B'], rawId: 'raw-1', inspectionId: 'inspection-1', receiptId: 'receipt-1'},
    {id: 'reader-2', order: ['B', 'A'], rawId: 'raw-2', inspectionId: 'inspection-2', receiptId: 'receipt-2'},
  ],
}
```

每路的三个 evidence ID 均可缺省。原始响应使用原始字节保存，inspection 来自 `validateReading`，execution 来自 `inspectExecution`，receipt 包含 `contextId` 与 `invocationId`。协议为 `continuous-review-1`，仅接受配套的 `continuous-review-reading-inspection-1` 和 `continuous-review-execution-inspection-1` schema。

| 状态 | 含义 |
| --- | --- |
| `unknown` | 缺少原件、校验或执行绑定；已有原件仍可读，有效偏好为空。 |
| `returned_invalid` | 校验失败；保留原文、自报偏好、评议、反读与范围说明，有效偏好为空。 |
| `validated` | 阅读校验通过，且原件、计划消息、上下文与调用标识绑定匹配；有效偏好只适用于本次阅读范围。 |

`rawText` 保留响应文本；`rawPreference` 与 `effectivePreference` 分列，消费者不得用前者回填后者。引用全部定位成功也不能覆盖证据来源契约失败。绑定、协议或引用位置矛盾会抛错，调用者应显示证据载入失败，不应退回无校验的有效结果。原始字节仍在 evidence store 中。

此适配器消费可信、已冻结的校验记录，不替代重新执行校验器。执行记录仅核对本地存档；不证明远端隔离。事实和文学判断仍需人工审查，任何状态都不代表全稿验收。没有接入具体页面或决定稿件采用与否。

从仓库根目录运行合成测试：

```sh
node --test tools/review-preview/tests/scoped-review.test.mjs
```

测试直接使用同仓库 continuous-review 的合成样例与实际校验函数，无网络、真实稿件、真实响应或本机目录依赖。
