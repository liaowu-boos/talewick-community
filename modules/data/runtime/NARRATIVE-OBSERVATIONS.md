# 叙事观察查询与供给

本模块提供叙事观察的版本、来源、引文和范围校验。公开仓库只包含代码与合成测试，不包含内部小说、旧卡、分析包或真实模型回包。新安装没有预装观察包；导入一篇文章也不等于已经生成并发布该层观察。

`createNarrativeObservationService({libraryRoot, sidecarRoot})` 从 `narrative-observations.mjs` 导出。调用方显式提供自己的资料库与通过校验的观察包目录。`query({contractVersion, query, fields, maxResults})` 按声明范围查询，返回来源、文本版本、原始字节及归一化正文哈希、逐字引文、位置和审核身份。查询版本为 `NARRATIVE_OBSERVATION_QUERY_VERSION`。

目录、相关原文或归档变化后，已有服务会报告 `NARRATIVE_OBSERVATION_SNAPSHOT_STALE`，需要重新打开。找不到资料可以返回空结果；损坏的证据不能进入供应。

## 材料附加观察

`service.projectMaterials({query, materials, budget?})` 只处理已经选出的最终材料。它不改变材料的 `id/content/sha256/use/references`，只可能附加 `narrativeObservations`。观察的所有引文必须位于该材料实际供应的来源行窗内；仅同源但位于其他章节的观察不供应。

默认上限为全包 4 项、2400 个 UTF-16 字符、每份材料 2 项，调用方只能缩小。零预算、无合格观察或投影失败时保留原材料。`createLibraryService` 可注入 `narrativeObservationProjector`；失败只标记附加层不可用，不把正常检索改成成功的观察供应。

历史 AI 观察与原文证据分别记录，不自动升级为当前已复核分析。规划后新增材料仍须显式采用，才能将其观察交给写作模型。观察中的读者效果属于假说，不代表真实读者验证。

## 批次与产品加载

`narrative-observation-batch.mjs` 提供证据窗口、分析与独立复核、失败响应保留、恢复、不可变包发布及激活指针校验。程序生成固定原文窗口；模型选择窗口标识，不能自行改写引文。使用这些开发接口需要配置自己的数据、选样清单和模型，可能产生调用费用。

产品启动时只读加载资料库下的 `narrative-observations/active.json`，验证包与来源数量后启用附加层。缺包或包无效时报告不可用，普通资料库仍可工作。开发接口的历史默认数量不表示公开版自带材料，调用者应显式传入自己的 `expectedSourceCount`。

测试见 `modules/data/tests/narrative-observations.test.mjs`、`narrative-observation-supply.test.mjs` 与 `narrative-observation-batch.test.mjs`，均使用合成文本和模型替身。

## Catalog 单元与候选批次

当前实现支持查询已复核 catalog 分析单元，精选摘要只作为浏览视图，不按等距位置自动认定开头、中段或结尾功能。`catalog-narrative-observation-package.mjs` 提供离线包构建和核验。

`remaining99-*` 与 catalog probe 是固定规模实验工具，仍有 99/136 来源的前置要求，不能直接当作任意资料库的一键导入工具。它们不携带数据，须显式提供自己的路径；候选生成、独立复核、激活与创作效果验证是不同状态。公开版不附带这些分析包。
