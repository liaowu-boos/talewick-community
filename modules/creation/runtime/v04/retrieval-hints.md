# V0.4 有界检索提示

2026-09-28 修正：当前主问题优先明确本场关系或处境、触发、希望呈现的情绪/理解/表达，以及迁移限制。选择同一机制不能退回同一固定模板；线索服务这一具体问题，不靠人物职业和道具换皮，也不强制所有故事同一情绪公式。未知环节如实留缺口。策略路径在同一次需求调用内由 storyProblem 编译主问题；不额外调用检索，不增加候选、材料、token输出或总字符预算。自由问题路径与事实用途不受机制列表限制。

作者视图的材料使用：`knowledgeForAuthor(knowledge, { materialDecisions, decisionMaterials } = {})` 或 `filterAuthorKnowledge(view, materialDecisions, decisionMaterials = [])` 只过滤投影，原packet、receipt、快照和计费不变。materialDecisions是本次有效计划的决定；空或缺省保持原视图。明确decline及可绑定到它的同内容哈希、同版本同源重叠原文区间、同分析版本同unit不再作为推荐材料传入；其id及决定理由只留在materialUse审计字段。decisionMaterials传原始/保留材料以识别补查替换id，不能凭空认定不同范围是同一材料。

有决定时新增 `materialUse={decisions,excludedMaterialIds,boundary}`，每项决定固定标记 `author_declared_not_text_verified`；不增加正文核验或文学提升结论。每次从未过滤的快照按当前决定重算，新计划明确adopt允许恢复；未声明的新材料保持待判断，不强制采用。初次规划仍看全包。实际正文、重规划、修订调用点与历史输入绑定的接入由workflow主控负责；旧绑定不能用新投影追溯改写，须以显式新策略标记区分新旧校验。

检索已连接时，原 requirements 的 2500 token 调用追加提示契约。新字段可省略；省略时不补默认、不改变原 requirements、query/context/stage/budget/sourceIds 或旧保存点。未连接检索时，原提示词不追加该契约。

`requirements.retrievalHints` 若存在，必须是只含 `focus` 与 `queries` 的普通对象，两者必须齐全。focus 只能为 scene、ending、echo；queries 为 0–3 项，每项是已 trim 的非空字符串，长度不超过 120 个 JavaScript 字符且精确唯一。额外字段、null、首尾空白、重复等均走既有 RequirementsFormatError 与一次修复机制，不静默清洗。undefined 按缺省处理。scene 是提示词建议的默认选择，代码不会补写省略的字段。

retrievalQuery 仅将合法提示复制到 query.recall；validateRetrieval 对请求与回显两侧严格检查并绑定相等。一次调用的总预算仍是最多20候选、6单元、12000字符，并受基础材料占用后的剩余30000字符上限约束，不按 queries 另行调用。

实际查询保存在 knowledge.retrieval.query，作者输入仅在实际 recall 存在时增加 recall 副本。断点恢复使用已有知识包，既不重新查询也不补旧字段。选中材料耗尽预算时没有实际查询，因此作者视图不伪造 recall。

未增加运行文件：共享校验器位于 knowledge.mjs，需求整理位于 workflow.mjs，现有 A/B runtimeDigest 已覆盖两者。旧实验不重封，必须另目录准备。check-retrieval 的封装本来只作内容哈希/版本核对，不含 runtimeDigest，保持旧包 inspect 不迁移的既有语义。

测试用固定响应是工程接口替身，不是真实模型成果。真实数据函数供给成功不说明 recall 的多路排序已经实现，也不证明研究或文学效果。raw/rejected 状态和 A/B 受信登记不因提示而升级。
