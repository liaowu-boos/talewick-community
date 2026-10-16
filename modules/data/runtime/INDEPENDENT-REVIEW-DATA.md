# 独立全文评阅的 DATA 接口

本页记录 `whole-quality-retrieval.mjs` 在 `whole-quality-retrieval-1` 兼容合同上的增量。旧的 `retrieveWholeQualityEvidence`、材料 packet 和 `used/not_used` 账本保持不变。

## 叙事观察参与召回

`retrieveWholeQualityEvidenceWithObservationRecall()` 先用完整 `issue.question` 显式查询现有叙事观察服务，再把查询结果中的真实来源、版本、原文行窗、UTF-16 位置和正文 SHA 转成 `observationSeeds`。随后只调用一次普通 `retrieveKnowledge`。检索运行时重新对当前索引验证种子；过期版本、错 SHA、错行窗和不唯一绑定不会进入候选。

观察种子只增加候选机会。候选仍走原有预算、相关性筛选和供给合同；观察本身不会自动成为材料。最多三条旧版 120 字短查询仍受原限制；较长 `sceneQueries` 原样放入 `recall.fullQueries`，上限 4000 字，不裁切。

```js
const result = await retrieveWholeQualityEvidenceWithObservationRecall({
  issue,
  queryNarrativeObservations: (request, options) => observationService.query(request, options),
  retrieveKnowledge: (query, options) => library.retrieve(query, options),
});
```

## 功能适用性

`buildWholeQualityApplicabilityReview(retrieval, assessments, options)` 在普通 relevance 之后单列四类判断：

- `direct_fit`：对当前问题、叙事功能和迁移边界有逐字证据，可进入规划候选。
- `mechanism_only`：只提供宽泛组织机制，不能当成直接适配材料。
- `inapplicable`：当前功能不成立；题材不同本身不是充分拒绝理由。
- `insufficient_context`：窗口不足，不能猜测来源全文。

没有 `direct_fit` 时必须给出 `noSuitableReason`，结果显式为 `noSuitableMaterial: true`。该结果不改写原 packet，也不宣称文学效果。

## 最终正文用材证据

`buildWholeQualityFinalTextUseEvidence({materialUseLedger, chapters, records})` 只处理账本中声明 `used` 的材料。每项记录必须给出最终章节、UTF-16 `start`、逐字 `quote`、修改组和来源 evidence ID；函数回查正文并保存章节正文 SHA 与引文 SHA。

允许显式记录 `not_located`，但必须说明原因。`located` 只表示最终正文中存在该逐字位置及作者声明的关联，输出固定 `automaticEffectClaim:false`、`literaryEffect:"NOT_COMPUTED"`；独立目标核查仍由 VALIDATION 负责。

## PRODUCT 的最小 C06 导出

`buildWholeQualityC06ReferenceList({retrieval, materialUseLedger, includeMaterialIds?})` 默认只导出声明采用的材料；调用方可再显式加入同一 packet 内的有限候选。每项保留材料正文、SHA、来源版本和行窗，字符总量仍受 12000 上限。

输出固定：

```json
{
  "coverage": "declared_used_materials_only",
  "completeLibraryComparison": false,
  "references": [
    {
      "materialId": "...",
      "useStatus": "declared_used",
      "scope": "fragment",
      "contentSha256": "...",
      "references": [{"sourceId":"...","sourceSha256":"...","textVersion":"...","lineStart":1,"lineEnd":9}]
    }
  ]
}
```

C06 只能把该清单描述成有限参考片段，不能写成已比较完整资料库。

## 验证

定向回归：

```sh
node --test modules/data/tests/whole-quality-retrieval.test.mjs modules/data/tests/independent-review-data.test.mjs modules/data/tests/recall.test.mjs modules/data/tests/emotion-context.test.mjs
```

夹具覆盖 宽泛机制误供给、高词面反例、显式无材料、观察新增来源候选、最终正文 UTF-16 核验和有限 C06 导出。测试只证明工程合同行为。
