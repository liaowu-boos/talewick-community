# 显式启用的交付证据接口

本补丁复用 `independent-review-task.mjs` 的七阶段运行时、产品 `independent-review-analyze.mjs` 桥接器及 `model.mjs` 传输层。默认不开启，不增加模型调用，不改变引用正确与文学通过的边界。

## 启用

```js
const request = withLiteraryReadingFocus(compareRequest);
const analyze = createIndependentReviewAnalyze({ model });
const result = await startIndependentReview({
  runRoot, request, analyze,
  modelCitationMode: 'paragraph_refs_v1', // 原有选项，建议保留
  evidencePolicy: 'sealed-delivery-evidence-v1',
});
```

仅接受 focused compare（v3）；未知策略、旧协议或 single 请求在建任务前拒绝。选项持久化在 task.json 并参与 requestHash。resume 从任务读取策略，不能通过换成未审计桥接器静默降级；缺失交付证据会保留完整回包并停止封存。普通未启用路径保留原行为。GUI router/service 尚未增加公开开关；生产接入应由服务器配置该选项，并同步更新服务的 requestHash 计算，不能只改前端显示。

`getIndependentReviewRequestHash({request, modelCitationMode, evidencePolicy})` 必须使用与 start 相同的选项。新增运行时代码参与 toolVersion；本补丁未提供旧任务原地迁移，建议新建明确启用的任务。

## 数据边界

运行时内部向 analyze 传递 `evidenceContext`，包含策略、stageId、protocolInputHash 和 priorSeals；前六阶段没有 differenceAudit。第七阶段先用原运行时逐份重验六个 seal、回包、协议结果及事件，再绑定六份 seal 的字节哈希，从冻结 request 的完整章节计算差异。此上下文属于宿主控制数据，不作为额外模型消息发送。

增强提示保留 user.packet 与原 inputHash。第一至六阶段仅补充通用事实规则；第七阶段才增加 `user.supplement.computedDifferenceAudit`。差异只证明文字相同或不同，不证明改善。

## 三层哈希及回执

- `inputHash` / `protocolInputHash`：原协议 packet、instruction 的既有哈希，不冒称覆盖新增提示。
- `deliveredInputSHA256`：增强后的 `{stage, system, user}`；另存 system/user 各自哈希。
- `requestBodySHA256` / `requestBodyByteLength`：实际传入 fetch 的 JSON 请求正文 UTF-8 字节，包含 model、messages 和模型参数。

model.complete 增加可选 `onRequestBody(serializedBody)`，在 fetch 前读取同一份序列化字符串；回执提供该字符串的字节哈希和长度。未传此回调的现有调用不新增字段。桥接器不自行伪造传输哈希，而是保存模型层回执并与增强提示校验。网络实现仅需支持这个明确接口；完全缺失该接口的旧模型适配器不能为启用任务封存。

本地 fetch 边界哈希不证明远端服务器实际收到请求，不构成供应商签名、计费凭据或抗恶意篡改存储。回包中的 provider/context/invocation 原标识保持原意。

## 每个 attempt 的持久化

`delivery-context.json` 在调用前保存。完整返回后原样保存 raw-response.txt 和 receipt.json，并保存 delivery-evidence.json（完整提示、binding、请求正文与原传输回执）、delivery-proof.json。验证后 proof 哈希同时进入 sealed.json 和 stage_sealed 事件；重读会重算并检查。完整返回但交付证据错误的请求标 DELIVERY_EVIDENCE_INVALID，原回包保留且不进入下一阶段。引用/JSON 错误保留原失败，不自动纠正或重试。

网络失败、截断、未完整返回、position recovery 及历史恢复任务仍有原运行时自己的处理规则；本首阶段没有验证增强策略与各种恢复/重试路径的完整兼容性，不应据此宣布它们可投入生产。

## 短引用接口

独立 Codex 形状的 `prepareCodexAnchorPacket` / `resolveCodexAnchorResponse` 仍是单独的离线引用审查接口，不硬塞进七阶段的另一种响应 schema。修复两点：所有失败路径明确 `passed:false`；同一 evidence 或 counterEvidence 列表中的重复 `(anchorId,quote)` 拒绝为 DUPLICATE_CITATION_IN_LIST。跨不同判断复用引用仍允许。同一锚点内多次出现同一句子、错误锚点和跨锚点拼接继续失败，不猜位置、不改回包。

`passed` 只表示 schema/引用完整性；`semanticSupportVerified:false`、`qualityPass:NOT_COMPUTED` 保持。证据段是否支持判断需要另做人工/语义核验。

## 离线验证

新增 `modules/validation/tests/independent-review-delivery-integration.test.mjs` 使用实际运行时、桥接器与模型传输，唯一替换点为 fetchImpl：返回内存 SSE 合成数据，零网络、零真实额度。可用 `TALEWICK_EVIDENCE_OUTPUT` 指定保存目录；缺省保存在临时目录，不向仓库外的固定目录写文件。

覆盖七阶段正常路径、默认关闭、错误回执、缺失审计、失败引用、缺失第六封存、被篡改的早期原回包、事后交付证据篡改、提前揭盲及短引用失败。合成回包复用响应契约示例，仅用于验证协议与流程，绝不充当真实文学评价。
