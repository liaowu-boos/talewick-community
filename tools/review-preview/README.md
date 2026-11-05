# 评阅证据展示适配器

`openEvidenceStore(root, trustedSHA256)` 读取在可信上下文中登记的清单摘要。调用方传入可信摘要，清单内的每项注册稿对、来源、类型、相对路径和文件摘要。`adaptResult(store)` 核对来源报告与统筹结论中的稿对和来源，再生成展示用 JSON。`ResultEvidencePanel` 接收该 JSON 和 `labels`。它复用项目中的 BoardUI Badge、ButtonLink、语义颜色和复合字阶。

`tests/fixture.mjs` 提供一个完整的双来源合成包。`reportId: null` 表示该来源尚未送入评阅结果，`conclusionId: null` 表示人工复核、文学判断和采纳建议均待定。原始来源只要有一个引用失败，汇总就保留失败。服务端通过真实基线和候选文件的字节摘要绑定稿对。来源归属由编制白名单的可信操作者核定，通用加载器不替代人工判断。

先在 `modules/product/talewick-gui` 安装锁定依赖并执行 `npm run build`。进入 `tools/review-preview` 后运行 `node --test tests/*.test.mjs` 检查合成包和回环 HTTP 服务。仅运行无监听部分用 `node --test tests/result.test.mjs`。构建用 `node src/build-preview.mjs BUNDLE TRUSTED_SHA NEW_OUTPUT GUI [GUI_WITH_DEPENDENCIES]`，其中 GUI 提供项目组件与已编译 CSS，依赖目录提供已有 React、TypeScript 和 esbuild。构建会做严格类型检查和静态渲染。输出目录须尚不存在，构建工具也会在其父目录生成 `render-preview.cjs` 供合成渲染验证。

使用 `node src/serve.mjs SITE TRUSTED_SITE_SHA 4965` 打开本地只读服务。HTTP 请求只查找构建时登记的路由。浏览器可使用证据 ID 和 SHA256 下载已校验的文件。文件系统路径、其他来源、符号链接、字节变动和未登记入口均受检查。

集成时把 `evidence-store.mjs` 与 `result-adapter.mjs` 放在服务端同一目录。前端使用 `ResultEvidencePanel.tsx`，由服务端传入视图与标签。默认产品评审接入口由统筹另行集成和回归。

## 对照意见的引文覆盖

来源报告可选填 `comparisons`。每项用 `id` 和 `label` 标识界面中的意见。`originalId` 指向同来源白名单内的模型原回包，`index` 指向其中的 `comparisons[index]`。阅读偏好取自该原回包的 `preference`。已知主证据精确定位次数可填 `exact`。没有逐意见证据的旧报告继续可读。

有覆盖报告时，`coverageId` 指向同来源、同稿对的 `comparison-citation-coverage-1` 证据 JSON，`rolesByBlindId` 取自封存时的盲号映射。适配器核对稿件章节摘要、原意见数组摘要、盲号、意见序号与每次引用的 JSON 路径，分别展示 `evidence`、`counterEvidence`、`severeHarm.evidence`。前者为主证据，后二者独立统计。

精确定位数按引用出现次数统计。修改段按核查器的版本、章节和正文段落单元去重，章题另属标题单元。两稿对应的正文段各有独立单元。覆盖证据缺失、定位不完整、段落归属未定或没有引用时，覆盖数为待核。只在主证据非空且全部命中共有正文段时，页面提示核对修改段原文。定位数与覆盖数均不改变原始偏好、文学判断或采纳状态。

## 可选的阶段回包诊断

在服务端停写后，用 FULL15 的 `readIndependentReviewStageDiagnostics` 读取可信的原生任务快照。把 `independent-review-stage-diagnostics-1` 原件和 `events.ndjson` 原字节作为同来源白名单证据。日志可用 `.txt` 保存，无须改动内容。在清单的 `sources[]` 项登记：

```json
{
  "stageDiagnostics": {
    "requestHash": "<冻结请求的哈希>",
    "taskMetadataSHA256": "<该次 task.json 原字节 SHA256>",
    "diagnosticId": "stage-check", "journalId": "events",
    "attachments": [{"stageId":"pair-review","attemptId":"attempt-1","rawId":"response"}]
  }
}
```

`taskMetadataSHA256` 与 `requestHash` 来自同一稿对、同一来源的可信登记。诊断、事件日志和附件都经过既有白名单文件校验。`rawId` 指向该次 `raw-response.txt` 原字节，适配器再次与诊断内的摘要、字节长度核对。只有匹配的返回事件和已保存原件才能显示被拒回包的自报偏好。引用类错误和其他校验失败分别标注。`unknown` 保留未知，`explicit_non_dispatch` 与 `no_attempt_in_snapshot` 分别说明未派发的依据。

若要显示有效封存偏好，在对应附件内另登记 `sealId` 和 `validationId`，分别指向原生 `sealed.json` 与该次 `validation.json`。仅在诊断确认当前阶段和尝试封存、比较记录摘要与封存事件一致，且该记录通过原生 `blind_pair` 校验时，才展示它的偏好。未导入可选证据时保守显示未知或没有可确认的封存偏好。显式错绑的请求、原件或验证摘要会被拒绝。阶段判定与旧报告的计数及统筹结论各自呈现。


连续三章协议的独立状态适配见 [scoped-review](SCOPED-REVIEW.md)，其合成测试与通用校验器共同运行。它需由调用方显式接入，不修改默认GUI评阅流程。
