# 三路只读阅读适配器

`src/isolated-reading.mjs` 消费 `isolated-anchor-reading-2` 的冻结计划、原件和校验存档，不调用模型、不改写回包、不执行采纳，也不创建页面或监听。要把同一组可信输入渲染为独立 HTML，见[离线报告](ISOLATED-REPORT.md)。

依赖同仓库 `tools/isolated-anchor-reading/review-tools.mjs` 及其 `prompt-templates.json`，必须使用与计划冻结时一致的版本。这个入口独立于旧 `scopedReaders`，不把新协议伪装为 AB/BA 两读者。

```js
import {adaptIsolatedReading} from './src/isolated-reading.mjs';
const view = adaptIsolatedReading({
  plan, expectedPlanSHA256, manifest, get: store.get, ref: store.ref,
});
```

`plan` 来自 `buildReadingPlan({manuscripts, chapterIds})`。chapterIds必须显式给定，A/B章节序列与范围逐项一致；视图保留该顺序和范围。`expectedPlanSHA256` 必须取自调用前冻结的可信登记，不从可变计划自行采信。适配器以 C1 的冻结稿件重建完整计划，并检查 S1/S2、私有绑定、packet、messages、模板和所有摘要；不向结果对象复制私有 A/B 来源意义。

`get`、`ref` 使用可信 evidence store。`get(id)` 返回 `{entry:{sha256},bytes:Buffer}`，`ref(id)` 返回可供消费者访问原件的引用。整个阅读 manifest 必须由调用者冻结并通过可信摘要验证，不能让 HTTP 参数自由指定证据路径。

```js
const manifest = {
  planSHA256: expectedPlanSHA256,
  requests: ['S1', 'S2', 'C1'].map(requestId => {
    // 协议槽位区分大小写；文件证据库的登记 ID 使用小写。
    const prefix = requestId.toLowerCase();
    return {
      requestId,
      rawId: `${prefix}-raw`,
      inspectionId: `${prefix}-inspection`,
      messagesId: `${prefix}-messages`,
      receiptId: `${prefix}-receipt`,
      // semanticReviewId 可选
    };
  }),
  executionId: 'execution', // 可选，inspectExecution 的完整存档
  // editorialDecisionId 可选
};
```

三个槽位及其顺序固定；每个证据 ID 均可缺省。没有 raw 时返回状态为 `unknown`，不推断未发出或调用失败。messages 是实际保存的消息数组，receipt 包含 contextId 和 invocationId。不能将计划消息冒充实际消息存档。

| 结果 | 含义与使用限制 |
| --- | --- |
| `requests[].returnState` | 原回包是否存在；JSON 不合法仍为已返回。 |
| `rawText` / `originalResponse` | 原响应文本与可解析 JSON。原始字节以 evidence 引用为准。 |
| `opinion` | 自由读感、总体评议、维度、逐章观察、事实主张、反读与范围；C1 另含变化评议。无效内容也只是原始意见。 |
| `protocolValidation` | `pending / passed / failed / binding_error`；保存的检查与针对当前 packet/raw 重新计算的完整检查深比较，不修补原报告。 |
| `semanticReview` | 独立人工复核。默认 pending；定位、覆盖或同文检查通过均不自动改变它。 |
| `execution` | 三路实际消息、原件和回执的独立绑定核查；不证明远端内部隔离或计费真实性。 |
| `preference` | S1/S2 恒为不适用，无偏好；C1 只有协议和执行均通过才提供机械核验偏好。 |
| `editorialDecision` | 默认未决定，仅展示绑定的编辑记录，不修改正文或执行采纳。 |

必须分列展示这些轴，不能用一个总“通过”徽标替代。S1/S2 只收到 X 单稿，不是两票；C1 是两稿全文加中立差异定位的辅助比较，不是隐藏差异的冷读。单稿若违规输出 preference，该字段只在原件/原 JSON 中保留作为失败证据，不进入 opinion.overall 或偏好栏。

`protocolValidation.inspection` 保留 bindingValid、schemaValid、anchorsValid、evidenceContractValid、identityCheck、differenceCoverage、errors、resolvedEvidence 等完整字段。取回引文来自冻结锚点目录，不等于模型自己逐字抄引或正确理解。覆盖结果里的变化段、上下文、共有措辞和缺失区域不可合并成简单引用总数。

`textIdentity` 直接取自重建通过的 C1 packet：全局 identical 同时涉及所提供章节的标题和正文，逐章 titleEqual/bodyEqual 分列。一部分章节改变而另一章同文，不构成所提供范围的全局同文。结构字段与自由文本是否自相矛盾仍需人工审查。

计划或原件字节完整性损坏会抛错，不能显示核验结论。已取得可信原件但检查/复核/编辑记录不匹配时，展示 binding_error，保留原件引用；任何核验偏好都不由不匹配检查获得。

## 可选人工复核与编辑记录

下面是展示层 sidecar 格式，不是校验器自动生成的结论。调用者导入可信人工记录时可生成绑定 sidecar，不能为得到通过而改写原响应或原始检查。所有摘要必须指向当前冻结存档。

```js
{
  schemaVersion: 'isolated-reading-semantic-review-2',
  planSHA256, packetSHA256, requestId, rawSHA256,
  status: 'failed', // pending | failed | reviewed
  scope: '明确写出已审主张和范围',
  summary: '复核结果及未完成部分',
  fullManuscriptAccepted: false,
}
```

`reviewed` 仅表示声明范围已审。语义失败不会覆写机械定位结果，也不会把原偏好抹掉；机械有效偏好不代表语义通过。

```js
{
  schemaVersion: 'isolated-reading-editorial-decision-2',
  planSHA256,
  rawSHA256ByRequest: {S1: rawHash1, S2: rawHash2, C1: rawHash3},
  status: 'use_as_working_draft', // pending | retain_baseline | use_as_working_draft
  scope: '本次工作底稿选择范围',
  summary: '独立编辑收益、代价和保留事项',
  fullManuscriptAccepted: false,
}
```

未返回路的 rawSHA256ByRequest 值为 null；之后原件到达需要重新绑定编辑记录，不能沿用旧快照。选择继续工作底稿不等于全稿验收。返回对象始终 `fullManuscriptAccepted:false`、`adoptionExecuted:false`，不按三路投票。

packet/messages/plan 使用协议 `valueSHA256` 的递归排序 JSON 值摘要。原回包及 evidence store 使用原始字节 SHA256。格式化 JSON 文件的字节摘要不能替换值摘要。

## 合成测试

```sh
node --test tools/review-preview/tests/isolated-reading.test.mjs tools/isolated-anchor-reading/review-tools.test.mjs
```

全部使用合成稿件和内存原件，无网络、真实回包或本机路径依赖。覆盖三路身份、错误 JSON、违规单稿偏好、同文矛盾、只引共句、错路锚点、计划及存档篡改、语义与编辑绑定，以及所有状态的独立性。


## 公共v2输入边界

本入口只接受 `isolated-anchor-reading-2` 并返回 `isolated-reading-view-2`。完整计划、消息及packet重建同时绑定chapterIds。旧版计划直接拒绝；旧版检查或人工记录schema作为binding_error保留原件，不授予有效结果。不存在静默换章号或升级旧记录的路径。

旧连续对读的 `continuous-review-1` 仍由scopedReaders专用入口处理，不与本入口混用。
