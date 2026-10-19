# 整稿质量独立验收协议

这套协议用于冻结后的原稿/候选稿比较。它不调用模型或外部服务，不修改正文，也不把盲审偏好、票数或分数换算成“通过”。实际阅读应使用未接触既往分析的独立上下文；协议校验本身不证明文学质量。

入口：

```sh
node modules/validation/runtime/whole-quality-evaluation-cli.mjs prepare REQUEST.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-prepare S01-request.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-validate STANDALONE_VALIDATE.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-followup FOLLOWUP_INPUT.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-merge STANDALONE_MERGE.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs validate VALIDATE.json
node modules/validation/runtime/whole-quality-evaluation-cli.mjs finalize FINALIZE.json
```

所有命令只读取显式文件并向 stdout 输出 JSON。调用方自行决定保存位置；程序不会隐式写文件。

候选稿尚未生成时，可直接把冻结的 Creation request 交给 `standalone-prepare`。它只读取 `requestId` 与 `chapters`，忽略 `projectTitle`、`idea`、`instruction`、`style` 等可能泄露书名、诊断或作者方案的字段。输出只有单篇匿名稿 `M`。记录用 `standalone-validate` 校验，而且 record 的 `readerId` 必须逐字等于 packet 的 `readerId`。

候选和正式 bundle 就绪后，以已校验的第一份单稿 packet/record 调用 `standalone-followup`。第二份正文只在第一份记录哈希封存后才进入 followup packet；followup packet 反向绑定第一份记录哈希。第二份单稿也校验并封存后，`standalone-merge` 才把两份记录映射到控制器内部的 A/B target。双稿 target 不是读者包，不得直接分发。

## 三阶段隔离

1. `independent_reading`：每个 packet 只含一稿；读者看不到另一稿、原稿/候选身份、问题清单、修订计划或目标。第一稿记录封存后才生成第二稿 packet。两名读者采用相反的角色顺序；两份单稿记录最后才映射成 A→B 与 B→A 的控制器 target。
2. `blind_pair`：身份和目标仍隐藏。每条比较结论都要同时引用 A、B；`hard_fact` 与 `editorial_hypothesis` 分开记录。禁止 score、vote、rank 等聚合字段。每个双稿记录绑定相应的独立初读记录哈希。新任务使用 `whole-quality-blind-pair-2`：严重问题必须另外填写结构化归属和该稿逐字证据，不能只给一个无归属布尔值。
3. `goal_audit`：完成盲比后才揭示身份、预先冻结的问题证据、反例/保留项、预期效果、失败条件和必须落地的 action/cognition/relationship outcome。每个 outcome 都要给原稿与候选稿逐字证据。候选更自洽或盲比更受偏好，不能替代实施证据。

阶段绑定使用 SHA-256。任何稿件、packet、引文、顺序或记录变化都会使后续校验失败。引文按章节 ID、UTF-16 `start` 和逐字 `quote` 回查；程序不做模糊匹配。

## prepare 输入

```json
{
  "caseId": "S02",
  "baselineChapters": [{"id":"ch-1","title":"第一章","body":"……"}],
  "candidate": {
    "mode": "revised",
    "chapters": [{"id":"ch-1","title":"第一章","body":"……"}]
  },
  "readerIds": ["isolated-reader-a", "isolated-reader-b"],
  "goals": [{
    "id": "goal-1",
    "statement": "目标陈述",
    "claimType": "editorial_hypothesis",
    "sourceEvidence": [{"chapterId":"ch-1","quote":"原稿逐字证据","start":0}],
    "counterCase": [{"chapterId":"ch-1","quote":"反例或应保留证据","start":20}],
    "expectedEffect": "修订前冻结的预期读者效果",
    "failureCriterion": "什么情况说明目标没有落实",
    "requiredOutcomes": [
      {"id":"outcome-action","dimension":"action","description":"必须实际发生的行动"},
      {"id":"outcome-cognition","dimension":"cognition","description":"必须显示的认知变化"},
      {"id":"outcome-relationship","dimension":"relationship","description":"必须落到文本中的关系变化"}
    ]
  }]
}
```

`candidate.mode` 可为 `revised` 或 `no_change`。`no_change` 必须与原稿哈希一致，避免用空改稿伪造候选。真正没有主要问题时，`no_change` 允许 `goals: []`；`revised` 仍必须有目标。空目标 no-change 的最终结果固定为 `goalFulfillment: "not_applicable"`、`adoptionBoundary: "no_change"` 和 `qualityGain: "NO_QUALITY_GAIN_ASSERTED"`，不会利用空集合把“所有目标都达成”算成真。

`prepare` 输出 `publicBundle` 与 `privateBinding`。`publicBundle.independentMergeTargets` 是控制器专用的双稿绑定对象，不是独立初读包；初读只能分发 `standalone-prepare` / `standalone-followup` 生成的单稿 packet。`goalPacket` 与 `privateBinding` 在盲比结束前也不能交给读者。

任务、bundle、private binding、result 与 completion evidence 必须属于同一条协议版本，不能混搭：

| evaluation | blind pair | private binding | result | completion evidence |
| --- | --- | --- | --- | --- |
| `whole-quality-evaluation-1` | `whole-quality-blind-pair-1` | `whole-quality-private-binding-1` | `whole-quality-evaluation-result-1` | `independent-review-compare-completion-evidence-1` |
| `whole-quality-evaluation-2` | `whole-quality-blind-pair-2` | `whole-quality-private-binding-2` | `whole-quality-evaluation-result-2` | `independent-review-compare-completion-evidence-2` |

任务适配器在第一次 provider dispatch 前、finalize 时和读取已完成报告时都校验这张表。若 v2 task 被替换为自洽的 v1 bundle/private binding，也会返回 `TASK_PROTOCOL_BINDING`，不会自动降级、补写 seal 或调用 provider。冻结的 v1 task 仍按完整 v1 行原样恢复。

core finalizer 还会重新计算两个 blind pair packet 中每篇匿名稿的正文 SHA，要求两份 packet 对同一 blindId 的 SHA 完全一致，并逐项核对 `goalPacket` 和 `privateBinding` 中 baseline/candidate 的角色与 SHA。CLI 和直接函数调用都不能仅凭客户端给出的哈希完成。

## validate 与 finalize

单阶段校验输入统一为：

```json
{"stage":"independent","bundle":{},"record":{}}
```

`stage` 可为 `independent`、`pair`、`goal`。字段采用闭合 schema；未知字段、伪造引文、过期哈希、缺少分类、单边 A/B 证据和计分/投票字段均拒绝。

pair v2 中每条 comparison 的 `severeHarm` 采用以下闭合结构：

```json
{
  "status": "none | attributed | unknown",
  "blindIds": ["A"],
  "evidence": [{"blindId":"A","chapterId":"ch-1","quote":"逐字引文","start":0}]
}
```

- `none`：`blindIds` 与 `evidence` 都必须为空。
- `attributed`：`blindIds` 列出实际含严重问题的匿名稿；`evidence` 只能来自这些稿，而且每个所列 blindId 至少有一条逐字证据。若 A 修复了 B 的冲突，只列 B，不能因两稿都参与比较而把 A 也列入。
- `unknown`：在盲态下确实不能归属时使用；`blindIds` 必须为空，`evidence` 必须覆盖 A、B。控制器不会从 statement 的自然语言猜测归属。

盲比封存后，控制器才用 `whole-quality-private-binding-2` 将 blindId 映射为 `baseline` 或 `candidate`。结果分别保存 `candidateRisks`、`baselineIssues` 和 `unknown`；偏好、目标落实和风险归属继续作为三条独立证据链。

最终输入：

```json
{
  "bundle": {},
  "privateBinding": {},
  "independentRecords": [{}, {}],
  "pairRecords": [{}, {}],
  "goalRecord": {}
}
```

最终结果保留每名读者的顺序、匿名稿选择、逐条比较和记录哈希。交换顺序后按匿名稿 ID 判断偏好是否分歧，不按 `first`/`second` 字面计票。程序不擅自推断两段自然语言意见在语义上是否冲突，`semanticDivergence` 固定为 `NOT_PROGRAMMATICALLY_ASSESSED`；原意见完整保留，供主任务明确列出未解决读法。结果边界：

- 严重问题明确归于候选，或两稿都受影响：`preserve_original`。
- 严重问题只归于原稿：保留为 `baselineIssues`，不把它算作候选损伤；仍由目标落实、偏好分歧和其他风险决定边界。
- 严重问题归属未知：`narrowed_recheck_required`。
- 目标未落实或失败条件成立：`goals_not_achieved`，即使候选盲比更受偏好也不能写成目标达成。
- 部分落实或读法分歧：`narrowed_recheck_required`，调用方须建立缩小范围的新比较包，不能直接混合采用。
- 目标逐项落实且没有严重伤害或分歧：`eligible_for_editorial_consideration`。这仍不等于自动采用、文学质量通过或系统通过。

`automaticAdoption` 永远为 `false`，`literaryPass` 为 `NOT_COMPUTED`。读者分歧原样保存在 `divergentReadings.records`，不进行多数决或总分汇总。

`qualityGain` 仍固定为 `NO_QUALITY_GAIN_ASSERTED`。候选被两名读者偏好、目标全部落实、或原稿存在严重问题，都不会被控制器自动改写成质量提升结论。

旧 `whole-quality-evaluation-1` / `whole-quality-blind-pair-1` 工件继续按原合同校验和恢复。旧布尔 `severeHarm` 没有结构化归属，控制器不读取 statement 猜测，也不修改 raw response、seal 或既有 result；旧路径保持原有保守边界。新归属规则只用于显式 v2 bundle。
