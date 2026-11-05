# 连续三章匿名阅读工具

离线构造匿名 A/B 阅读提示，并检查响应结构、逐字引文、证据来源与段落变化覆盖。只依赖 Node.js 内置库，建议使用 Node.js 22 或更新版本。工具不发送请求、不管理供应商、不读取配置或密钥，也不改写稿件和原始响应。

## 使用

每稿提供三个连续章节，按原顺序用本次阅读窗口内的 `ch-1`、`ch-2`、`ch-3` 标识。每项严格包含 `{ id, title, body }`。这些是局部编号，调用者在模型消息之外保存它们与原稿章节的映射；标题、正文、标点和空白保持原样。

```js
import {
  buildReadingPrompts,
  validateReading,
  inspectExecution,
  inspectChangeCoverage,
} from './review-tools.mjs';
import { manuscripts, makeResponse } from './synthetic-fixture.mjs';

const planned = buildReadingPrompts({ manuscripts });
// planned[0].messages 按 A、B 呈现，planned[1].messages 按 B、A 呈现。
// 此处只演示合成响应的离线验证。
const raw = JSON.stringify(makeResponse());
const inspection = validateReading({ manuscripts, raw });
const coverage = inspectChangeCoverage({
  manuscripts,
  citations: inspection.references,
});
```

调用者先私下决定 A/B 绑定，两路保持同一绑定并使用全新、独立的上下文。每路消息只有 system 和 user，不带另一读者意见、来源版本、改动目标、差异目录或预期赢家。先冻结实际消息与来源快照的摘要，再由调用者自行安排阅读；保存原始响应后验证，不自动重试或修补结果。

自由阅读意见、五个评议维度、三章覆盖、最强反读和事实检查在同一提示中提供。输出先写自由读感，不代表评议标准事先不可见。编号提示建议使用 A_E1/B_E1，但实际来源由 `version`、`chapterId` 与原文决定，相同句子也要分别登记两稿证据。

## 接口

| 函数 | 输入与结果 |
|---|---|
| `buildReadingPrompts({ manuscripts })` | 返回两份完整提示，含 `readerId`、`order`、`system`、`user`、`messages` 和 `messagesSHA256`。 |
| `validateReading({ manuscripts, raw, expectedRawSHA256? })` | 接受原始字符串或 Buffer，返回结构、引文、来源契约检查及变化覆盖；可核对预存的原始字节摘要。 |
| `inspectChangeCoverage({ manuscripts, citations? })` | 返回改变、跨章移动、同章重排、重复匹配歧义与未引用段落。`citations` 可使用验证器的 `references`。 |
| `inspectExecution({ planned, executions })` | 检查两路留存消息与计划是否一致，以及上下文和调用标识是否不同。 |

`executions` 每项为 `{ readerId, messages, raw, receipt }`，其中 receipt 含非空 `contextId` 和 `invocationId`。这只核对调用者提供的存档，不证明远端内部隔离、请求费用或传输真实性。

协议标识为 `continuous-review-1`。结果 schema 分别为 `continuous-review-reading-inspection-1`、`continuous-review-change-coverage-1`、`continuous-review-execution-inspection-1`。另导出 `PROTOCOL_VERSION` 与 `sha256`。

## 验证边界

- 引文须在对应稿件、章节正文中逐字且唯一出现，长度不超过 240 个 Unicode 字符。位置按 JavaScript UTF-16 偏移返回。标题不作为正文引文来源。
- `schemaValid`、`citationsExact`、`evidenceContractValid` 分别描述结构、定位与证据范围，使用 `valid` 查看全部检查是否通过。失败时 `preference` 为 null；原始响应仍由调用者保存。
- **引用定位不等于语义成立。** 找到原句不能证明它支持某个事实、因果关系或文学偏好。`factJudgment` 与 `literaryJudgment` 始终要求人工审查，`fullManuscriptAccepted` 始终为 false。
- 变化段被引用只证明位置命中；双方共有措辞另行标记。重复段、重排、标题及空白变化需结合全文复核，覆盖比例不是文学分数。
- 身份措辞提示只匹配少数表达和字段，可能漏检，也可能命中仅指某个相同章节的正确陈述。没有提示不等于事实正确。

结果分列审查，不用少量读者意见或精确引文数量投票决定稿件质量。这一工具仅检查所提供的三个章节。

## 测试

从仓库根目录运行，所有样例均为无名角色的独立合成短文本，无需网络或外部文件。

```sh
node --test tools/continuous-review/*.test.mjs
```
