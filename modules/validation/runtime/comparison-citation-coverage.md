# 比较引文覆盖接口

在比较评阅完成、稿件身份揭示后调用 `inspectComparisonCitationCoverage`。它检查每条引文在指定原稿中的位置，再判断该位置属于共有段、已改段还是待判段。单条评语的支持证据、反证和严重损害证据分别汇总。

```js
import { inspectComparisonCitationCoverage } from './comparison-citation-coverage.mjs';

const { manuscriptBindings, blindPairReviews } = verifiedReport.completionEvidence;
const manuscripts = Object.values(manuscriptBindings);
const input = {
  baselineChapters: manuscripts.find(m => m.role === 'baseline').chapters,
  candidateChapters: manuscripts.find(m => m.role === 'candidate').chapters,
  rolesByBlindId: Object.fromEntries(manuscripts.map(m => [m.blindId, m.role])),
};
const results = blindPairReviews.map(({readerId, recordSha256, record}) => ({
  readerId, recordSha256,
  coverage: inspectComparisonCitationCoverage({...input, comparisons: record.comparisons}),
}));
```

**输入**。两稿分别是 `{id,title,body}` 章节数组，章 ID 在同稿内唯一、跨稿稳定。盲号绑定取自同一份已重验的完成记录。每条 comparison 的 `evidence` 必填，`counterEvidence` 与 `severeHarm.evidence` 可选。沿用原有 `{blindId,chapterId,quote,start}` 结构。缺省字段为正文，显式传入 `field:'title'` 时才检查标题。公开版原生段落引用只引用正文；此扩展供已有独立标题引文的调用方使用。

**定位**。`start` 是指定字段内 UTF-16 偏移，结果区间为 `[start,end)`。给出偏移时严格逐字验证。缺省或为 null 时，仅在指定稿、章、字段内有唯一逐字匹配才派生位置。多个匹配计为 `ambiguous`，错位、缺文计为 `inaccurate`，无效定位范围计为 `invalid`。输入原文和引文保留原样。

**如何认定改段**。同章正文按空白行分段，分隔符不参加段内容匹配，单个换行仍属于段内文字。检查所有最长顺序匹配。某段必须与对稿同一段逐字匹配，才判 `shared`。完整段文在对稿本章不存在，判 `changed`。重复或移动导致配对不确定时标 `unresolved`。章内两侧各自的段号与区间保存在 `units`。明确的单边空档标为插入或删除，双边有文的变动区域标 `replacement_region`，不推定一对一替换。新增、删除的整章单独标明。章节顺序本身不作为段内改写。

**特殊边界**。章节仅改变分段空行时列入 `separatorOnlyChapterIds`；仅标题改变时，共有正文引文不算覆盖标题。跨段引文列出其实际触及的全部非空文字单元。引文命中改段但只摘了两稿都有的一句话，也属于段落级覆盖。`sameQuoteInCounterpartField` 另列这句文字是否出现在对稿同章同字段。长段不会按模型锚点长度再切分。单章匹配矩阵超过一百万格且两侧段序列有差异时，完整段文只出现在一侧仍可确定有改动；其余配对保留待判。

**输出给展示层**。`citations` 给出原引文、JSON Pointer、`location`、`coverage` 与 `unitIds`。`comparisons[i].byChannel.evidence` 表示单项判断的支持引文；顶层 `byChannel` 是该读者各项的合计。`exact` 是定位精确条数，`sharedParagraphOnly` 是仅触及共有正文段的条数，`changedParagraph` 与 `changedTitle` 分别是触及改段与改标题的条数。重复引用按出现次数计，但 `changedUnitIds` 按稿侧单元去重。`coversChangedParagraph`、`coversChangedTitle` 都是三态：有确证命中为 true，没有命中且该范围全部可判为 false，证据为空或仍有相关未决引用为 null。部分证据命中时 true 可以与其余待判引文并存。

**绑定与范围**。`binding` 中两稿哈希取有序 `{id,title,body}` 数组的 `JSON.stringify` UTF-8 字节；比较记录哈希取输入比较数组的 JSON 字节。它们用于复核本次检查的内容，完整任务身份、原包及封存校验由上游负责。`semanticSupport` 与 `literaryEffect` 返回 `NOT_COMPUTED`，`automaticAdoption` 为 false。
