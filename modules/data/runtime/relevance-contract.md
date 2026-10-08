# US05 有界适用性筛选：接口冻结

新增 `relevance.mjs`，不改变 library-index-3.1，不自动改写查询或增加候选。

```js
import { createRelevanceAssessor, validateRelevanceReview } from './relevance.mjs';
const assessRelevance = createRelevanceAssessor({ model });
const library = await createLibraryService({ rootDir, model, assessRelevance });
// 也可注入固定协议替身：assessRelevance({system,user},{signal}) => Promise<string>
const result = await library.retrieve(query, { signal });
if (result.relevanceReview) {
  const receipt = await library.getRelevanceReview(result.relevanceReview.receiptId);
}
```

factory 只执行一次 `model.complete({stage:'library-relevance',system,user,maxTokens:6000,signal})`；不解析、不修复、不重试。模型应走既有统一调用适配器/预算，DATA 不新建供应商客户端。未配置保持原行为；与旧 reviewCandidates 同时配置为函数时初始化 INVALID_INPUT，在开存储前拒绝。旧 hook 的参数和原有筛选逻辑保持兼容，但不能与新模式叠加使用。

`library-relevance` 的正文请求预算仍为 6000 tokens；官方 native Flash（以及 `usesDeepSeekThinking(config)` 已支持的原生 V4 别名）显式启用 `thinking.type=enabled`，思考与正文合计总上限为 32768 tokens，不是独立正文配额，也不代表每次耗尽。非 native 及未匹配该策略的旧模型仍以 6000 为输出上限。完整 user 输入仍限 48000 字符（48k），消息、JSON `response_format`、提示词和解析协议不变；无自动降级为非思考、无额外重试。空正文、截断、超时或取消均失败并保留既有记录。其他 library 阶段保持显式非思考和原正文预算。

## 输入及程序省略

仅处理当前经 catalog 摘要认证后的最多 20 个索引候选。每个候选先调用原 `organizeMaterials([candidate], query.budget, cachedText)` 得到完整单候选预备材料；其中已经包含原文 6 行/280 字扩展与完整 reviewed 焦点分析/全部必需关联原文。不能在 700 字 core 上判断后供应未审扩展内容。

单候选须可在原预算/范围/单元限制内完整供应，且内容 ≤4800 字符；失败则 `notReviewed.reason='candidate_material_budget'`，保留 organizer 的限制说明。不是模型判 irrelevant。按排名整候选加入输入，完整 user JSON（包括转义字符和 inputHash 字段）超过 48000 时整项省略，reason='input_budget'。system 固定且 ≤2000 字符。query 与 sourceIds 原样保留，不预设题词/同义词/窗口。

user 结构为 `{inputHash,schemaVersion:'library-relevance-2',query,candidates}`。inputHash 是除自身字段外这个 payload 的 `SHA256(JSON.stringify(payload))`；system 原文独立存 receipt，不宣称此 hash 认证语义正确。candidates 含 candidateId、preparedMaterialId、use、sourceId/sourceSha256/textVersion/analysisVersion/indexVersion、适用时的 focusUnitId/reviewRecordId、完整 content、contentSha256、完整 references。只有这些候选可获判定。

无送审候选不调用 assessor。若 query 基底本身超过输入限制，全部候选以 input_budget 省略，user 为 null（从未送出），inputHash 仍绑定实际 query 和空候选 payload。performance、空 sourceIds、零检索预算等原本提前返回的路径保持零调用，可无 relevanceReview。

## 响应

```json
{"inputHash":"原值","decisions":[{"candidateId":"原ID","relevance":"usable","reason":"不超过200字符的非空理由","evidenceQuotes":["本候选原文短引一","本候选原文短引二"]}]}
```

relevance 仅 usable / irrelevant / insufficient_context。sent 候选必须每项恰好一次；未知 ID、重复、漏项、错 hash、坏 JSON、未知额外字段、错误枚举/理由结构都失败。`library-relevance-parser-4` 仍兼容顶层可选的 `type:"json_object"`，其值必须完全匹配；该标记不替代 inputHash，也不能出现在 decisions 内。供应商原始字符串仍逐字保存，返回的业务 decisions 不变。无修复调用、无循环、无旧 hook 或词法材料回退。仅 usable 的原索引候选进入原 organizer；模型理由不进入正文，不发布分析，不批准文学效果。

同一次 query 使用受验文本缓存，避免各候选重复读取同书原文，并确保最终组织采用同一个文本快照。最终 organizer 的单项扩展与预备阶段相同，之后只合并已扩展的相邻/重叠窗口，不再扩大合并边界。`bindFinalMaterials` 逐字核验最终 raw 正文为 usable 预备完整窗口的并集，reviewed 正文/refs 与其 usable 预备材料完全相同。最终材料中出现未送审/insufficient/irrelevant 窗口、缺口或新文本时 unavailable，不供给。

原 20/6/12000、单书 4800/3 与原单段2400预算不变。raw合并超过2400时回到各自独立完整窗口，预算允许即保留两份；limits明确列出相邻/重叠窗口ID，重叠字符按各份重复计费。包含于已供完整窗的重复候选不重供；reviewed重复规则不变，独立窗仍超预算则整窗跳过，不截断，不扩大预算，不跨缺口伪造连续上下文。

usableCount只统计模型标签，不等于最终材料数或语义成功数。receipt新增内部 `unsuppliedUsableCandidateIds` 列出未被finalMaterialBindings覆盖的usable，存在时公共limits提示核对供应；八字段摘要不扩展。此字段是完整候选绑定口径：即使部分原文与已供窗重合，也不能假装整候选已供应。

## 可选摘要：严格八字段

```ts
type RelevanceReview = {
  receiptId: string; // 小写 UUID，安全文件 ID
  inputHash: string; // 始终64位小写hex，任何状态均不允许null
  status: 'completed' | 'failed' | 'not_reviewed';
  sentCount: number;
  notReviewedCount: number;
  usableCount: number;
  irrelevantCount: number;
  insufficientContextCount: number;
};
validateRelevanceReview(value, {
  status, candidateCount, maxCandidates = 20, materialCount
});
```

value 为 undefined 时返回 undefined，不补字段。其余严格八字段；返回结构化副本。计数均为 0–20 的安全整数，sent+notReviewed ≤ min(20,maxCandidates)。给定 candidateCount 时，completed/not_reviewed 两种状态下 sent+notReviewed 必须等于候选数；failed 可小于候选数（例如准备过程中就失败），但不能超过。

- completed：sent≥1，三个模型分类之和恰好等于 sent。
- failed：三个模型分类必须全部为0，**没有非零分类合法例外，inputHash 也不允许 null**。送审清单可以非空；原始响应保留，不把协议失败中的自称判断计作有效分类。
- not_reviewed：sent=0，三个分类全部0，notReviewed可非零。
- matched：必须 completed 且 usable>0，有材料。
- uncovered：不能 failed，也不能有程序省略、insufficient 或 usable；可为全部明确 irrelevant 或确无候选。
- unavailable：允许错误、部分来源不可用、省略/上下文不足、以及 usable 候选最终因完整材料预算无法供应等情况。若存在 usable 可供材料，允许 matched，但 limits 说明部分未评估。

此共享函数只检查结构、计数和结果状态；UUID/hash 格式通过绝不代表 receipt 或内容可信。绑定实际查询/材料哈希/来源版本仍由既有检索合同验证。作者 view 本轮不加顶层摘要、不改白名单；理由在 receipt/详情中查看。

## Receipt 与恢复

独立保存 `rootDir/relevance-reviews/<receiptId>.json`，`getRelevanceReview(receiptId)` 仅接受安全小写 UUID，未知 ID 为 NOT_FOUND。普通 source detail/list 不返回 receipt、system 或 user。

记录含 schemaVersion、parserVersion、receiptId、packetId、query、inputHash、精确 system/user、sent 完整预备内容和版本/refs/sha、程序 notReviewed 及原因、rawResponse、有效 decisions 或 errorCode，以及 finalMaterialBindings（每个最终 materialId/contentSha256 → usable candidateIds 与完整 refs/窗口 hash）。最终映射只证明供应源于已送审材料，不证明模型选对。

新回执固定保存 `parserVersion:'library-relevance-parser-4'` 和 `schemaVersion:'library-relevance-2'`，输入schema沿用r02的2（相对r01的1已有变化）；公共检索合同与严格八字段摘要不变。历史回执不补写版本、不重新批准。只读审计历史原响应时，显式传入 `inspectRelevance(raw, {inputHash:receipt.inputHash,input:{schemaVersion:receipt.schemaVersion,candidates:receipt.sent}}, {parserVersion:receipt.parserVersion ?? LEGACY_RELEVANCE_PARSER_VERSION})`；parser-1仍只接受两个顶层字段，parser-2允许已知type，两者仍按旧decision三字段读历史。未知版本拒绝，新schema输入禁止指定无引文协议的parser-1/2；新任务的旧usable格式失败，不静默降级。读取getRelevanceReview本身不解析、不重写历史。

parser-4中，usable必须有 `evidenceQuotes: string[]`，1—4条不同引文，每条2—160 UTF-16字符（去首尾空白后至少2字符），总长度≤480。仅按原字符串匹配，不归一化标点、换行或空白。每条须完整落入该候选content自己的一个原文块内，不能跨分离引用拼接，不能来自分析概述、标题、limitations或其他候选/sharedText未引用块。原文块从正文尾部按references行数和分隔符反向解析；分析里伪装的原文标题不能代替真实引用块。irrelevant/insufficient_context可只带candidateId/relevance/reason，也可附evidenceQuotes:[]；非空或非数组值仍拒绝，原响应及decisions原样保留。旧格式、错引文或不完整输出均整次失败，不保留部分usable。

单一事实或一句直接回答可只用一条引文，不用数量替代语义。reason仍限200字符，须解释引文共同支持的关系。对同一“先—再—并”复合机制，必要环节不能拆成多个独立情绪需求来放行；独立事实/表达混合用途原规则仍保留。字面校验只验证候选边界，不证明引文与问题相关、主体正确、因果充分或文学有效；这些仍须真实模型判断与独立语义审阅。

新bindFinalMaterials重新检查parser-4决策，不能通过直接传入未带引文的旧decisions绕过门禁；各独立raw最终窗仍须完整由自己的已送审usable窗口组成，各窗之间同版重叠行也必须一致。历史绑定重现应使用历史冻结代码，不把旧记录改成新批准。

调用前保存中断状态，收到响应先保存原响应再校验；格式失败仍能读取精确system/user、sent、rawResponse及errorCode，决策计数清零；候选内引文验证失败额外保存validationError的固定code与candidateId，不复制供应商异常详情。准备阶段失败无实际送审正文时，hash 绑定 query+空候选基底，system/user 可为 null。调用中断的 receipt 不等同于供应商确认收到请求：真实网络计数/超时仍由统一 model 适配器 receipt 判定。读取记录不调用模型；已有 frozen packet 不回填/重审，显式重新 retrieve 才产生新记录及可能的一次新调用。

## 验证边界

固定响应测试和 run10 重放只验证工程筛选路径。familiar 不在候选时仍无法被本模块找回，run09/run11 待批准真实测试未被替代。未接入 factory 的旧路径不会自动获得语义能力。原索引真实性绑定及其可信 catalog 边界保持不变。

## r02消费者与部署边界（历史）

新决策字段仅存在适用性receipt，不进入创作正文或公共八字段摘要。GUI `server/relevance-integration.test.mjs` 的usable固定响应须同步新引文格式，由主代理协调；本轮不修改该消费者文件。另需协调 `followup-materials.mjs` 的PARTIAL_RAW_OVERLAP策略：r02当时的创作补取消费仍可能拒绝这两份独立窗中的后者（后续修复见下方r06现状）。本轮只修复检索组织和引用边界，不宣称补取端到端已解决。新三题重跑须冻结新loader/parser/prompt/runtime和inputHash；旧r01包、真实响应、报告保持只读，不能给旧响应补引文后冒称真实结果。

## r03提示词与最小兼容

末尾完整示例明确inputHash必须逐字复制输入，分别展示usable、irrelevant、insufficient_context，取消顶层type提示。parser-4仍可读取已知type:json_object包裹，但inputHash绝不能省略，也不会自动补值。usable始终要求1—4条本候选精确原文引文；仅非usable允许缺省或空数组。parser-3保留严格旧引文语法供显式历史检查；parser-1/2仍不能用于schema-2新任务。输入schema仍为2，原问/窗口未变时inputHash保持相同；r03的prompt、parser、代码差异由包manifest与systemSha256冻结，不能用相同inputHash把r02失败宣称为r03成功。

## r05正文内嵌

新packRelevanceInput始终保留各候选完整连续的content字符串，不生成正文contentParts；仅原样共享重复limitations，并完整还原其顺序、重复项、空白及版本。共享有收益时仍用shared-text-2（sharedText为空），否则全部内嵌。历史shared-text-1/2解码保留，旧记录不迁移。r03 system、schema-2、parser-4保持原样。48k完整user、20候选、6000正文请求tokens及供应预算不变（r06的原生思考总上限见下文），按原排名超限整候选记notReviewed；序列化大小改变可能改变入选组合，新wire重新计算inputHash，不按题目或来源强保候选。

## r06现状：模型预算与补取整窗

本轮保留 r05 system/user/schema-2/parser-4 与 48k 输入限制，正文请求仍为 6000 tokens；官方 native Flash 的思考与正文总上限为 32768，适用范围由产品 `usesDeepSeekThinking(config)` 决定。该总上限不是实际消耗或单独正文保证。无自动非思考恢复、无额外重试，失败仍走原协议拒绝路径，不能用已有 usable 或词法结果兜底。

`followup-fix-r01` 已补齐同版、同源且重叠行逐字一致的独立整窗接收，重叠字符按各份计费；每次新结果仍校验单书最多3条/4800字符、单原文范围2400字符，不追改历史材料。上方 r02 段为历史未接通边界，不能据此描述当前消费者。整窗接收和精确引文校验通过，只证明工程边界；实际材料用途与引文是否覆盖完整关系仍须如实独立审阅，不能将 r06 三题协议有效当作完全准确率。

## 2026-10-01 有界完整性恢复候选

本段只描述候选新代码，正式部署另由主控决定。原批响应缺项时，先确认输入hash、已知顶层形状、返回ID唯一且都属本批，并用原parser-6对每个已返回decision及引文作完整核验；仅纯漏项启动恢复。坏JSON/hash、重复/外来ID、坏字段或引文均直接失败。恢复丢弃原批的全部标签，按原顺序每组最多4项重新送审**所有**已送候选，组输入各有独立hash，全部组严格通过后才合并供给。最长1+5次DATA assessor调用；底层provider可有自己的截断恢复，实际POST逐次计入统一账本。

`assessPreparedRelevance` 为生产和离线固定病例共用入口，初次与各组共用同一最多600000ms截止，并叠加调用者取消。原始全批响应留在receipt.rawResponse；`recovery.groups[]`逐组保留inputHash、system/user、完整sent、rawResponse、状态及有限错误定位。未完成或任一组失败时总receipt的decisions清零且不供应材料。这里的恢复只修复协议覆盖，不批准模型语义；独立审读仍须检查理由、引文和正文作用。新提示明确来源人物关系/题材不必复刻目标，并要求同一候选所有已携原文中的旧理解、新知到达、理解变化及必要行动有可定位依据；不能只看焦点，也不能把仍存疑虑说成旧信任。

## 2026-10-01 r02：正常固定小组（离线候选）

送审数超过4时，正常路径即按原顺序分为每组最多4项；此时**没有**一次完整原批模型请求。总receipt保留完整prepared的`inputHash`和`sent`，新增`requestMode:"fixed_groups"`，根`user`和`rawResponse`均为null，避免把未发送的完整user冒称实际请求。实际请求在`normalReview:{version:"relevance-fixed-groups-1",groupSize:4,groups:[...]}`，每组记录独立`inputHash/system/user/sent/status/rawResponse`及可选`completedAt`。组内仅纯漏项触发一次本组全部候选再评，先前部分判定作废；它的`recovery:{version:"relevance-coverage-partition-1",missingCandidateIds,groups:[...]}`含每组最多2项的完整请求/原响应/状态。状态`pending`、`validated`、`incomplete`或`failed`只描述尝试，不是材料批准。所有正常组及所需子组严格通过，才按原`sent`顺序汇总全部决策并做最终材料绑定；任一处失败，总receipt状态failed、业务decisions=[]、零供应。送审数不超过4时保留旧单批receipt和同一有界恢复路径。

20候选最多5个正常组、10个恢复子组，即15次DATA assessor调用；native适配器每次可能再做一次截断恢复，理论最多30个provider POST，真实数以账本和wire为准。所有请求共用整次600000ms上限及调用者取消。新提示把目标题材、身份、结局和代价视为新作约束：来源已有结果不必复刻，迁移限制仅约束借用，只有禁止借用部分与所问机制不可分才排除。所问为认知重解时才要求旧理解、新知进入、新理解；其他表达需求按各自必要环节核对。固定分组与提示改动均须同一冻结原12和holdout做真实r02对照；协议有效、usable数量或材料供给均非文学质量结论。

## 2026-10-01 r03：来源证据辅助视图（候选，未部署）

`deriveSourceEvidenceScope(query)` 只对已知结构、`purpose:expression` 的模型提议产生 `source-evidence-scope-1` 视图；它保留原证据需求、必要上下文、规则及 basis，并绑定完整 query、referenceNeed、targetUse 的哈希。`origin:schema-checked-model-proposal-not-user-requirement` 只表示结构核验，不表示用户语义授权或提议正确；`authority:auxiliary-never-overrides-explicit-source-constraints` 明确其辅助地位。事实、表现、普通自由文本或不合结构的上下文不生成该视图，仍依据完整原问。模型提示必须保留原问中明确指定的来源身份、对象或手段要求，同时不得自动把新作的角色、题材、结局当作来源门槛。程序无法证明模型对这些语义的理解正确，需真实边界测试。

视图只作为 `prepared.input.sourceEvidenceScope` 的可选字段加入；具体 `query.query/context`、召回、候选正文与限制均不改写。新 packed 输入及每个分组的 hash 包含视图。parser 对携带视图的输入再次核对其是否等于原查询的精确派生，防止改动后仅重算外层 hash；旧无视图 prepared 与 receipt 不补写、不重判。实验若从冻结父输入派生，须另存新 prepared 与父输入/模块/包哈希，并明确它是新输入，不能伪称历史请求未变。

正常小组、有界纯漏项恢复和整体失败隔离仍遵守 r02。`usable` 缺少独立 `evidenceIds` 字段属于证据格式失败，即使 reason 文本提到编号，也不得自动补造、复用部分标签或作为有效供给。候选的离线通过与实际模型判定质量分别记录。
