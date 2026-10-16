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
2. `blind_pair`：身份和目标仍隐藏。每条比较结论都要同时引用 A、B；`hard_fact` 与 `editorial_hypothesis` 分开记录。禁止 score、vote、rank 等聚合字段。每个双稿记录绑定相应的独立初读记录哈希。
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

## validate 与 finalize

单阶段校验输入统一为：

```json
{"stage":"independent","bundle":{},"record":{}}
```

`stage` 可为 `independent`、`pair`、`goal`。字段采用闭合 schema；未知字段、伪造引文、过期哈希、缺少分类、单边 A/B 证据和计分/投票字段均拒绝。

最终输入：

```json
{
  "bundle": {},
  "independentRecords": [{}, {}],
  "pairRecords": [{}, {}],
  "goalRecord": {}
}
```

最终结果保留每名读者的顺序、匿名稿选择、逐条比较和记录哈希。交换顺序后按匿名稿 ID 判断偏好是否分歧，不按 `first`/`second` 字面计票。程序不擅自推断两段自然语言意见在语义上是否冲突，`semanticDivergence` 固定为 `NOT_PROGRAMMATICALLY_ASSESSED`；原意见完整保留，供主任务明确列出未解决读法。结果边界：

- 有任一带证据的严重伤害：`preserve_original`。
- 目标未落实或失败条件成立：`goals_not_achieved`，即使候选盲比更受偏好也不能写成目标达成。
- 部分落实或读法分歧：`narrowed_recheck_required`，调用方须建立缩小范围的新比较包，不能直接混合采用。
- 目标逐项落实且没有严重伤害或分歧：`eligible_for_editorial_consideration`。这仍不等于自动采用、文学质量通过或系统通过。

`automaticAdoption` 永远为 `false`，`literaryPass` 为 `NOT_COMPUTED`。读者分歧原样保存在 `divergentReadings.records`，不进行多数决或总分汇总。
