# 有界多片段供给与冻结检查

新的 retrievalQuery 显式请求 evidenceType=narrative。validateRetrieval 接受历史省略值及 narrative/performance 枚举，其他值拒绝；实际响应 query 必须完整回显，不把旧响应补字段后冒充新查询。当前没有表现材料 schema，因此 performance 查询必须返回空 materials；raw_reference 和 reviewed_analysis 两种叙事材料均拒绝。uncovered 与 unavailable 仍区分保存，不能以小说原文作 ROI 等指标证据。

同书可以返回多份材料，每份可以带多个不连续引用，正文、引用数组、逐来源版本/哈希/复核记录及限制按原样保存。原文区间不因分析单元ID相同而合并计数；raw_reference 按 sourceSha256/textVersion/行区间去重计预算，同字节别名的重复区间也拒绝而不静默裁剪。reviewed_analysis 继续按独立分析单元计数并要求逐条复核来源。部分重叠区间的合并和真实来源去重仍由数据服务负责；消费者不猜测原文连续性或改写引用。

knowledgeForAuthor 返回隔离副本，修改作者视图不改变冻结材料。旧 workflow 检查点不重查询、不补 evidenceType、不自动晋级 use。源合同合法只说明字段和内部绑定可用，不表示复核记录已通过登记真实性回查，也不授予 A/B 准入。trusted-packets 保持独立审核边界。

## 独立离线检查

```sh
node modules/creation/runtime/v04/check-retrieval.mjs freeze case.json new-output-dir
node modules/creation/runtime/v04/check-retrieval.mjs inspect new-output-dir/frozen.json another-new-dir
```

case.json 包含 request、规范化 requirements 和数据服务实际返回的 result。freeze 计算当前新查询并验证原始 result 的精确绑定，再经过真实 prepareKnowledge → prepareWorkflowKnowledge → knowledgeForAuthor，保存 frozen.json 和 report.json。不能为通过检查重写结果 query 或添加虚构复核记录。必须传新目录，不覆盖历史文件。无模型适配器、无数据服务调用，不读取密钥。

inspect 只检查已经封装的保存内容哈希并投影作者视图，保留历史无字段状态，不重新跑新查询合同或宣称历史已复核。这个本地哈希用于一致性检查，不是防篡改签名。

新测试 delivery-contract.test.mjs 使用显式合成材料，但数据合并、工作流保存点和作者视图均用真实代码。恢复测试在规划输出前停止，不生成正文。数据新检索器到位后，可用其原始结果运行 freeze；现有合成测试不能计为真实语义检索或文学效果验收。
