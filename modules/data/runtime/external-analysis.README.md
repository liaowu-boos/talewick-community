# Codex 外部分析初始导入

`external-analysis.mjs` 只适配已完成的外部分析与独立复核工件。它不启动 agent、不请求供应商、不写 library 的 catalog、index 或 indexIntegrity。业务发布仍由现有 `createLibraryService` 的初始导入流程执行。相关例程全部使用临时目录；正式库由主控选择和操作。

## 输入与真实 receipt

`prepareExternalAnalysisInput({bytes, completeness, request})` 接收固定原文 bytes、用户范围声明和**原始请求文件字符串**；返回 `source/request/input/inputSha256/transport`。也可传冻结的 `system` 生成初始请求，或传捕获的完整运行时请求对象。传字符串保留 pretty JSON、键顺序和末尾换行；SHA256 计算精确 UTF-8 字节。对象输入会生成新的序列化字节，不能复用旧文件的 receipt。

`prepareExternalReviewInput({bytes, completeness, analysisOutput, request?})` 用现有 `inspectAnalysisCandidate` 重建分析，以未经改写的 `analysisOutput` 计算 `validation.responseVersion`，按现有首次生产流程应用覆盖范围钳制。保留完整初始对象，包括 canonical `version`、`reviewStatus:'candidate'`、字面验证字段和 `semanticReview:null`。不会重新计算钳制前已生成的 canonical version。`request` 可传已冻结复核文件字符串；完整解析内容必须匹配，包括 system、所有源行和候选元数据，不能只有 version 相等。顶层和 user 内部 JSON 的排版不影响内容比较，文件 SHA 仍各自按原字节记录。

桥接构造参数：

```js
const bridge = await createExternalAnalysisBridge({
  journalDir, // 独立伴随账本目录，不与 library 根目录共用
  producerPolicy: {
    analysis: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    review: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  },
  verifyAgentReceipt, // 主控实现：从可信调度/完成账本读取，不从模型回答中授信
});
```

`verifyAgentReceipt(receiptId)` 必须返回主控已核实的 `{receiptId, producer:'codex', status:'completed', agentId, model, reasoningEffort:'high', inputSha256, outputSha256}`。分析与复核均验证，且真实 `agentId` 必须不同。主控须核对调度身份、model/effort、实际完成、实际读取输入及输入/输出文件的哈希；agent 自写 `receipt.json` 只有 requestedModel/SHA/fullInputRead 不足以授信。不要把 artifact 自带的 approved、verified、agentId 直接映射成可信回执。桥接在注册、回放和结果绑定时都会重新查询 verifier；回执撤销后不能继续使用。

预算来自共用的 `analysis-budget.mjs`：新的首次分析默认 `library-analysis-budget-v2` / `maxTokens:16000`；复核仍为2000，`library-analysis-revision` 仍为12000且不属于外部初始桥接阶段。这里只改变生成预算和简洁表达指导，不改变分析 JSON 必需层、1–40 单元、证据或发布校验，没有硬字符门槛、自动重试、截断补全或多批流程。

v2 的 `request.user` JSON 必须包含 `analysisBudgetPolicyVersion:'library-analysis-budget-v2'`，它随完整请求参与 inputSha256 和 receipt 校验；只有精确16000可接受。新工件/绑定采用 `codex-external-analysis-2`。旧 `codex-external-analysis-1` 请求仍须无该字段且精确12000；不允许在旧请求内补写 v1 声明、重标16000或复用修改前签名。`registerArtifact` 按已签请求推导工件版本，也可显式传 `schemaVersion`，但必须与请求策略一致。已存工件的版本在重开、回放和绑定时再次核对，不迁移或改写旧工件。

`prepareExternalAnalysisInput` 未传 request 时默认生成 v2。`system` 仍由主控提供**当前完整冻结提示词**（包括新简洁指导），函数不擅自修改传入的 system；最稳妥的方式是传实际捕获的请求字符串。若明确重放旧 v1，可在准备旧初始请求及创建 library 时设置 `analysisBudgetVersion:'library-analysis-budget-v1'`；v1 保留原 system/user/maxTokens 字节结构。传入已捕获请求时从请求校验版本；若同时显式指定 analysisBudgetVersion，两者必须一致。新默认 runtime 不会静默消费旧 v1 工件，跨版本须准备和认证新请求。

Codex 外部 agent 执行不保证该 API 上限，provenance 的 `referenceProviderMaxTokens` 从已验证请求读取，v2另记 `analysisBudgetPolicyVersion`，并保留 `codexMaxTokensEnforced:false`。`providerRequests:0` 只表示本次外部回放没有实时供应商调用；已发生的 agent 执行由主控独立记账。实际供应商 wire 上限仍由产品 adapter 记录，不能用此参考元数据代替真实回执。

## 初始生命周期

```js
const registered = await bridge.registerArtifact({
  bytes, completeness: 'unknown',
  analysis: { input: analysisRequestText, output: analysisRawText, receiptId: analysisReceiptId },
  review: { input: reviewRequestText, output: reviewRawText, receiptId: reviewReceiptId },
});
const library = await createLibraryService({ rootDir, model: bridge.model });
// 保持默认 reviewAnalysis；不要设置 null 或注入批准函数。
const imported = await bridge.importSource(library, {
  artifactId: registered.artifactId, bytes, fileName, completeness: 'unknown',
});
// 用 library.get(sourceId,{includeAnalysis:true}) 等待现有队列进入终态。
const provenance = await bridge.bindLibraryResult(library, imported.source.sourceId, {
  artifactId: registered.artifactId,
});
// 使用完毕依次关闭 library 和 bridge。
```

注册成功只表示绑定检查完成。`analysisDiagnostics`、`reviewDiagnostics` 与 `reviewApproved` 是现有 inspector 的结果，不能据此自行写 checked。字面合法分析先为 candidate；复核必须满足现有六项协议及一致性要求。合法拒绝由 library 留为 `needs_review`；缺失复核、格式失败或引用范围失败留为 failed，原输出保存在 journal 和适用的 library drafts 中。裸 `approved:true` 不通过六项协议。SHA/结构正确不证明语义关系正确，真实六项理由仍应供独立阅读核查。

`bindLibraryResult(library, sourceId, {artifactId})` 从实际 service 读取记录，核对原文、完整分析、原始复核响应版本、六项判断及已发生的回放交付，再写伴随 provenance。返回 `{binding, semanticReview}`；后者包含新增 `producerProvenance`，`method` 仍为通用的 `model-library-review`，来源明确是 Codex / external_replay。**当前 stock catalog 本身不嵌入这个来源字段**；报告/接入方必须保存并使用该返回值或伴随绑定。若需要底层消费者直接读取 provenance，需要另行确认 library 接口，本轮未改动。绑定步骤中断后可对同一终态记录重复执行，不重跑模型、不新建 source、不改 indexIntegrity。

## 幂等、失败与显式恢复

同一 source bytes 的重复导入先查已有 canonical source，原有条目原样返回，不增 alias、不覆盖原6或其分析。并发首次导入使用稳定 requestId，现有 library 事务负责去重。工件注册与交付串行；独立 journal 拒绝第二个活跃 owner。正常关闭后可重开；死亡 PID 可独占恢复。若在 owner 恢复过程再次崩溃留下 `owner-recovery`，桥接保守拒绝自动竞争清理，由主控确认没有存活进程后处理。

所有注册尝试先留原始 stage 字符串；失败另记 outcome，不覆盖旧工件。active 指针更新须传 `expectedArtifactId`，不接受过期前版。该参数仅切换可回放工件，不修改 library 已有分析，也不自动重试。

复核尚未完成时可用 `review:null` 导入；分析保存后复核阶段失败。后续保留**原 analysis input/output/receiptId**，新增 review，显式注册前版 ID，再调用既有 `library.retry(sourceId)`。已存 canonical analysis 不重做。外部 review 输入始终是首次生产候选，不含旧批准或历史；恢复时只容许实际运行时出现格式严格、同源同版本的 failed 记录，将其还原为初始 null 后核对所有剩余字段。完整运行时触发请求另存 delivery，旧失败 history 留在 library。任何 approved/rejected 或额外元数据都不能通过这条恢复规则。

若分析本身未通过，既有 library 的显式 retry 会加入 `previousAttempt` 和重试 system。初始工件不能静默复用：桥接失败交付记录保留该实际请求，主控据此安排新的真实分析及独立复核，再显式更新工件和 retry。不会截断、补引文或自动改原模型输出。

已生成 `checked/needs_review` 的内容修改不属于本模块范围，继续走既有 `submitAnalysisRevision` 与显式复核流程。初始 raw、首次拒绝和后续修订历史都须保留；本模块不接管修订请求。

## 离线验证

```sh
node --test modules/data/tests/external-analysis.test.mjs modules/data/tests/analysis-candidate.test.mjs modules/data/tests/analysis-review.test.mjs modules/data/tests/library.test.mjs
```

上面的旧桥接验收曾记录12个新增及31个相关测试、43 pass。预算v2的针对性验证另运行：

```sh
node --test modules/data/tests/analysis-budget.test.mjs modules/data/tests/external-analysis.test.mjs
node --test modules/data/tests/analysis-review.integration.test.mjs modules/data/tests/analysis-revision.test.mjs modules/data/tests/submitted-candidate.test.mjs modules/data/tests/batch-scheduling.test.mjs
```

预算v2新增7个测试，加原桥接12个，共19 pass；后四文件56 pass（含子测试）。范围包括原v1签名和12000回放、新v2声明及16000元数据、预算/版本篡改拒绝、截断/transport length后不发布索引、重启无自动调用、显式完整重试、40单元与关联保留，以及revision12000/review2000。均使用真实临时文件和明确的合成回执/模型替身；真实模型调用为0。不能据此声称16000必不截断或文学/语义质量提升。
