# 独立单稿阅读与差异辅助比较

`isolated-anchor-reading-2` 提供离线提示构建、冻结锚点检查和三路执行存档核验。它只使用 Node.js 内置库，不请求模型、不读取密钥、不写稿件，也不自动决定文学质量或采纳。

| 请求 | 模型收到什么 | 允许的结果 |
| --- | --- | --- |
| S1 | A所对应的一份完整匿名X稿 | 单稿读感、维度、逐章观察、事实主张和反读；无稿间偏好。 |
| S2 | B所对应的另一份完整匿名X稿 | 同上；独立上下文，不提供S1的意见。 |
| C1 | 固定匿名A/B两稿全文和中立逐字差异 | 差异辅助比较、变化效果、取舍、反读及比较偏好；不提供S1/S2意见。 |

这不是三张盲评票。C1明确看见差异位置，不是隐藏差异的冷读。各路同时看到自由阅读要求和评议标准，不能称先盲读后揭示标准。

## 运行合成示例

从仓库根目录运行，使用合成短文本与虚构回执，全程不联网：

```sh
node --input-type=module <<'JS'
import {buildReadingPlan, validateResponse, inspectExecution} from './tools/isolated-anchor-reading/review-tools.mjs';
import {manuscripts, chapterIds, makeResponse} from './tools/isolated-anchor-reading/synthetic-fixture.mjs';

const plan = buildReadingPlan({manuscripts, chapterIds});
const executions = plan.requests.map(request => ({
  requestId: request.requestId,
  messages: request.messages,
  raw: JSON.stringify(makeResponse(request.packet)),
  receipt: {
    contextId: `synthetic-context-${request.requestId}`,
    invocationId: `synthetic-call-${request.requestId}`,
  },
}));
const inspections = plan.requests.map((request, i) => validateResponse({
  packet: request.packet,
  expectedPacketSHA256: request.packetSHA256,
  raw: executions[i].raw,
}));
console.table(inspections.map(result => ({
  request: result.requestId,
  contractValid: result.valid,
  preference: result.validatedPreference,
  semanticReview: result.factJudgment,
})));
console.log('Synthetic archive valid:', inspectExecution({plan, executions}).valid);
JS
```

虚构回执只用于演示，不是实际发送或远端隔离的证明。真实接入时，调用方先冻结源稿、私有版本映射、完整计划和提示，再分别安排新上下文；保存实际发送消息、未经修补的原回包和真实回执。不能用计划消息替代实际发送存档，也不能把本工具的本地检查称为远端签名认证。

## 接口与冻结范围

`buildReadingPlan({manuscripts, chapterIds})` 接受严格的 `{A: chaptersA, B: chaptersB}`，以及必填的非空有序 `chapterIds` 数组。可以提供一个、两个或更多章节。每个ID是1至80字符的ASCII字母、数字、下划线或短横线，首字符须为字母或数字；ID唯一，区分大小写，不自动排序或规范化。每稿各项严格包含 `{id,title,body}`，其章节ID序列必须与 `chapterIds` 逐项完全一致。缺章、多章、重复ID、两稿顺序或范围不同均拒绝，不自动截取、填补、重命名或取交集。标题、正文、标点、换行和空白保持原样；A/B的来源意义由调用方私下保存。

计划与每个packet都包含独立复制的 `chapterIds`，范围纳入packet、messages和plan摘要；响应schema的逐章观察数量和章节枚举按该范围生成。

返回的 `plan.requests` 按 S1、S2、C1排列，各项包含 `packet`、`packetSHA256`、`messages`、`messagesSHA256`。计划还包含私有映射和 `planSHA256`；不要把整个计划连同私有映射直接发送给读者，只发送各路自己的 `messages`。

`validateResponse({packet, expectedPacketSHA256, raw, expectedRawSHA256?})` 接受原始字符串或 Buffer。预期 packet 摘要必须来自调用前可信冻结记录。工具重建目录、差异和响应契约，拒绝稿件、锚点、指令或契约的错绑；不修补响应。完整响应 JSON Schema 位于 `packet.responseContract`。

`inspectExecution({plan, executions})` 接受三项 `{requestId,messages,raw,receipt}`，receipt 含非空 contextId、invocationId。它核对实际消息与计划一致、标识互异、原件摘要正确；不证明远端内部隔离或费用。

packet、messages、plan 使用 `valueSHA256`：对象键递归排序、数组顺序不变，再序列化计算摘要。raw使用原始字节SHA256。不要把格式化JSON文件的字节摘要混作这些值摘要。模块也导出 `PROTOCOL_VERSION`、`sha256`、`valueSHA256`。

## 检查能证明什么

原回包的 evidence 每项为 `{id,version,chapterId,anchorId,supports}`。模型只选择锚点并声明它支持什么，验证器从冻结目录取回原文、UTF-16位置和摘要。`resolvedEvidence` 不表示模型自行正确抄写了引文，更不表示 `supports` 的主张成立。

| 结果字段 | 边界 |
| --- | --- |
| bindingValid / schemaValid | 输入与冻结摘要、结构契约的检查。 |
| anchorsValid / resolvedEvidence | 锚点存在且稿别、章号匹配；不自动裁决语义支持。 |
| evidenceContractValid / differenceCoverage | 证据来源与差异区域覆盖；不能把共有句或邻近上下文当成已引用另一侧实际变化段。 |
| identityCheck | 比较结构化 `identical / different / uncertain` 与冻结标题及正文。uncertain保持不确定；自由文本中相反说法仍需人工发现。 |
| rawPreference / validatedPreference | 原字段保留；比较响应失败时有效偏好为null，单稿不产生偏好。 |
| factJudgment / literaryJudgment | 始终 requires_human_review。 |
| fullManuscriptAccepted | 始终false。 |

检查报告 schema 为 `isolated-anchor-reading-inspection-2`，执行检查为 `isolated-anchor-execution-inspection-2`。原始返回、契约、人工语义复核和编辑决定的展示接入见[三路适配器](../review-preview/ISOLATED-READING.md)。人工复核和编辑记录需要独立可信来源，不能由机器检查自动填成通过。

逐章证据齐全不代表每条跨章主张都有充分引文：总体评议只引首段仍可能通过契约校验，支持关系须另行人工复核。

差异定位保留标题、正文、分隔空白。正文按空行分段，以确定性的精确段落LCS对齐；重复段或重排可能存在多种合理对齐，不能据此唯一还原创作动作。每章超过一百万个动态规划格时抛出 `ALIGNMENT_SIZE_LIMIT`，不会静默改成近似差异。

## 验证与接入

```sh
node --test tools/isolated-anchor-reading/*.test.mjs
node --test tools/review-preview/tests/isolated-reading.test.mjs
```

测试为独立合成输入，覆盖原文保持、错稿错章、跨读者锚点、同文误判、只引共句、插删和重复段、检查记录绑定及各判断轴的独立性。它们不替代真实提供商兼容性、语义支持或文学质量验证。

当前工具没有接入默认GUI，没有自动重试或“修到通过”的流程。依赖和完整回归命令见[依赖清单](DEPENDENCIES.md)。


## 版本边界

本公开接口仅接受 `isolated-anchor-reading-2`。旧版 `isolated-anchor-reading-1` 的冻结计划、packet、检查报告及展示sidecar不被自动转换或重算成新版有效结果。需要重放旧实验时使用原冻结工具；需要使用新范围时显式构造并冻结新计划，不能把版本号或章号替换后冒充原请求。

三路视图为 `isolated-reading-view-2`，可选人工记录为 `isolated-reading-semantic-review-2`、`isolated-reading-editorial-decision-2`。旧连续AB/BA协议 `continuous-review-1` 仍由它的专用scopedReaders入口处理，与这里的版本升级无关。
