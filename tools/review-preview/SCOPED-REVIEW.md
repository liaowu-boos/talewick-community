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

展示消费者必须将以下结果分列，不能用一个“通过”标记代替：

| 字段 | 展示范围 |
| --- | --- |
| `machineCitations` | 机器引用定位通过、失败或未完成，不评价引文是否支持主张。 |
| `semanticReview` | 独立语义复核状态。缺少绑定记录时恒为 `pending`，包括警告列表为空时。 |
| `textComparison` | 从冻结正文直接计算的全范围与逐章同文结果及正文摘要。全范围仅指所提供章节。 |
| `inspection.warnings` | 上游措辞提示原样保留；可能误报或漏报，不能代替主张范围或事实结论。 |

`factualWarningMeaning` 明示空列表不代表事实正确。现有 `state` 和 `effectivePreference` 仍只记录机器契约与执行绑定；即使机器有效，也必须同时显示语义未完成或未通过，不得把机械有效偏好称为事实成立或编辑采纳。

可在每路配置中增加 `semanticReviewId`，指向可信 evidence store 内的冻结人工复核记录。此可选格式是展示层接口，不是 continuous-review 校验器输出，也不根据关键词自动生成：

```js
{
  schemaVersion: 'scoped-semantic-review-1',
  rawSHA256, manuscriptsSHA256,
  status: 'pending', // pending | failed | reviewed
  summary: '说明已审范围、未完成部分或未通过原因。',
  identityClaims: [{
    path: '/overall/assessment', // 原响应 JSON Pointer
    text: '原响应中的完整字段文本',
    assertion: 'bodies_equal',
    scope: 'chapter', // chapter | all_provided_chapters
    chapterId: 'ch-3', // 全范围时省略
  }],
}
```

人工负责确认这条原始主张是否在断言正文同文，以及它指哪一范围。适配器核对原回包、稿件摘要、原文路径和完整字段文本，然后只计算该同文断言与冻结正文是否相符。不会从“完全相同”等措辞推断它指所有章节。局部同文相符也不自动完成语义复核，更不判定同一句中其他因果或动机主张正确；未列主张不因此得到结论。明确的全范围同文矛盾不能标为 `reviewed`，可保留 `pending` 待核或由审阅者记录 `failed`。

`reviewed` 仅表示记录声明范围内的复核已完成，不是全稿事实或文学验收。复核记录绑定失败会拒绝载入；引用检查结果与原始意见保持独立，不被复核记录改写。正文比较逐字包含空白，不把标题差异混作正文差异；章节 ID 或顺序不一致会拒绝比较。

从仓库根目录运行合成测试：

```sh
node --test tools/review-preview/tests/scoped-review.test.mjs
```

测试直接使用同仓库 continuous-review 的合成样例与实际校验函数，无网络、真实稿件、真实响应或本机目录依赖。
