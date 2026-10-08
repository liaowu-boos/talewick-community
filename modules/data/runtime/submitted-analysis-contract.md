# 外部校正候选提交（隔离候选 API）

`await library.submitAnalysisRevision(sourceId, {expectedAnalysisVersion, sourceSha256, textVersion, content, provenance})`

仅登记，不自动生成、复核、发布或建立索引；即使配置了模型也不会调用。返回 `kind:'submitted_candidate', status:'needs_review', phase:'review_pending'`。来源当前活动分析保持不变。待审登记不占用后台 worker，多个独立待审候选可共享当前父版本；正在执行的任务阻止提交，首次发布后旧父候选不能继续提交/复核。

顶层字段必须且只能为上述五项。content 必须且只能包含 overview、coverage（scope/notes）、units、limitations；units 每项必须且只能含 id/title/event/psychology/emotion/expression/readerEffectHypothesis/locator/evidence/relatedUnitIds；locator 只有 lineStart/lineEnd，evidence 每项只有 quote/lineStart/lineEnd。不接受版本或任何批准元数据；完整旧分析必须由调用方明确投影为内容。输入 JSON 最大 256000 UTF-8 字节。原校验器负责引文、行范围、单元引用及数量边界；不自动更改内容，不额外附加 limitation，校验后内容须深相等。用户未声明 full 时，候选 full 被拒绝而非自动降级。

provenance 必须且只能包含 artifactSha256、analysisVersion、parentAnalysisVersion、revisionId。后三项是外部编辑来历（1–200 字符），不同于本次服务生成的身份，不能用来批准或引用服务版本。artifactSha256 是调用方声明的外部工件哈希；API 不读取该文件、不认证声明。service 另行计算 `submission.contentFingerprint = SHA256(JSON.stringify({textVersion,overview,coverage,units,limitations}))`，绑定实际登记内容。服务生成新 UUID 与 analysis-submitted 版本，以真正 expectedAnalysisVersion 为服务父版；保存 external_offline_edit 来源类型，不创建伪 model analysisResponse，不继承 semanticReview。

登记前核对 canonical source 的 hash/text/current analysis，验证原始 .bin 与派生原文绑定，复用版本归档与串行目录事务。失败不改变活动分析/索引；目录写入失败恢复内存并清理未提交的修订文件。进程骤停可能留下未被目录引用的不可达 journal，与现有存储边界一致；不会自动发布或批准。

以后显式 `retryRevisionReview(sourceId, submittedRevisionId, {expectedAnalysisVersion})`，配置真实复核器后复用现有 review_only 分支。该调用创建新的复核尝试身份，保留登记候选内容指纹和 derivedFromRevisionId。最多一次 `library-review` 调用，maxTokens=2000，六项 analysis-review-v2 协议必须通过；无生成/自动修复/自动重试。有效拒绝的相同内容在相同服务父版下不能从原提交或其重试链再次复核；新内容仍应走新提交。有效批准才由既有事务归档、索引与发布，reviewRecordId 由服务记录真实复核结果时生成。

无复核器时登记仍可用，但 retry 报 REVIEW_UNAVAILABLE，重启不自动调用。活动 review 的取消/关闭恢复、有效拒绝及批准、协议失败和旧引用均沿现有流程处理。API 本身不包含真实供应商预算授权：当前 40/40 剩余 0，调用方禁止配置可用真实调用能力；未来须获得新授权并在统一适配器封住额外调用。禁止注入伪 approved/human/trusted 响应。
