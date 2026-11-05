# 阶段返回诊断接口

在已停止写入的原生任务上调用 `readIndependentReviewStageDiagnostics({runDir, requestHash})`。`runDir` 由服务端选择，必须是已有任务的绝对 `run` 目录，`requestHash` 使用调用方已知的冻结请求哈希。

```js
import { readIndependentReviewStageDiagnostics } from './independent-review-stage-diagnostics.mjs';

const diagnostics = await readIndependentReviewStageDiagnostics({runDir, requestHash});
const fifth = diagnostics.stages.find(s => s.stageId === '05-reader-1-pair');
```

返回 schema 为 `independent-review-stage-diagnostics-1`。`stages` 保持原计划顺序，每项含 `stageId`、`state`、`reason` 和 `attempts`。每次尝试保留 `attemptId`、`inputHash`、`state`、`reason`、`providerReturnEvents`、`failureCode` 及 `rawResponse`。存在的原回包文件给出 `{sha256,byteLength}`，不存在时为 null。`counts` 是各状态的**阶段数**，重试次数单独看 attempts。报告还绑定 `requestHash`、`taskMetadataSHA256` 和 `eventsSHA256`。

| state | 判定及展示含义 |
|---|---|
| `sealed` | 同一尝试已有封存事件与原生封存文件，派发、返回、回执、记录及验证值相符。段落模式另对照原回包字节绑定，增强模式另核对已有交付证明与事件的绑定。表示观测到原封存。 |
| `returned_invalid` | 派发及返回事件依次出现，保存的原始响应可读取，随后该尝试进入带错误码的 `stage_needs_attention`，且无封存。错误码可以属于引用、JSON、协议或回执校验。 |
| `unknown` | 派发后缺少返回凭据、回包缺失、证据矛盾，或虽有返回但尚未作有效性判定。`providerReturnEvents` 与 `rawResponse` 区分实际观察到的事件与字节。界面宜显示“结果待核”，不能一概写成“模型没有返回”。 |
| `not_dispatched` | 本次静止快照中该计划阶段没有尝试，或有明确未派发事件及相符的本地证据。`no_attempt_in_snapshot` 与 `explicit_non_dispatch` 分别标明依据。 |

显式未派发后另一次尝试被拒绝时，阶段呈现 `returned_invalid`，历史尝试各自保留。证据有冲突时保守呈现 `unknown`。空文件具有空串的 SHA256 和长度 0，与文件缺失不同。`rawResponse` 是本地 `raw-response.txt` 的字节摘要，不是网络接收证明。

任务身份不符、存在工作锁、事件日志截断、路径重定向或快照读取中发生变化时，拒绝生成报告。若调用方没有完整的原生任务快照，应保留原有展示并标明该诊断不可用。本接口读取显式传入的可信任务目录，不发布原文、路径、偏好或采纳判断。对于普通封存，诊断核对已有记录的绑定，不替代上游的完整协议重放。默认任务创建、恢复和展示路径继续使用原接口。

已有 `parsed-response.json` 时，另比对它与原回包的 JSON 值。单阶段的证明文件 JSON 损坏时仅将该阶段标作 `unknown`。未封存的回包若没有外部原始哈希，只能说明当前存档字节及其摘要。
