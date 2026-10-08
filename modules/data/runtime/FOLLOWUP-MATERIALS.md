# US05 材料合并器接口（先行契约）

`mergeFollowupMaterials({ active, retained = [], result })` 同步纯函数，返回 `{active, retained, usedChars, chargedChars, accepted, dropped, superseded, packetId, resultStatus}`。调用前必须用创作端 `validateRetrieval(result, actualQuery)` 严格校验实际查询及响应；helper再检查必要形状、哈希及硬预算，不负责发起检索、核验外部源或证明采用。

retained采用**全量累计接受账本**，包括仍active的材料和已经被替代的旧材料。初次可传空retained，helper将active补入账本；以后直接传上次输出。相同ID且完整冻结材料一致的active/retained重合只计一次（对象键顺序无关，数组顺序和全部字段须一致）；不同ID的历史整份材料分别计费。原retained条目与先后顺序不改，新增整份追加。usedChars=active正文字符总数；chargedChars=retained正文字符总数，均JS UTF-16 length。所有手选/内置/首次及补查累计30000；替换不退还旧材料费用，新大窗按整份追加计费。单次result仍20候选/6材料及引用单元/12000字符，并尊重其更紧query预算。无正文或引用裁切。

helper防御校验单次返回包的来源预算：按sourceSha256+textVersion聚合别名，每源最多3份材料、4800字符；raw与reviewed都按整份content计费，重叠行与标准头部均重复计入。多源引用材料按每个不同源各计整份，不能借拆refs漏计。新包中单引用raw的原文正文上限2400字符，只扣除开头精确匹配的标准LF原文头部。这些上限与retrieval相同，超限抛INVALID_RESULT，不裁切或只留下预算内的前几份；不将每源3份/4800追溯为跨轮历史上限。历史仍遵守30000累计预算与原有身份校验。

每条accepted为 `{id, sha256, chargedChars, supersedes:string[]}`；dropped为 `{id, code, reason, conflicts:string[], coverageGaps:ReferenceRange[]}`；superseded为 `{id, byId}`。只表示进入材料上下文/被拒/被替代，不表示模型实际采用。packetId/resultStatus原样复制，原result不变；matched即使全部丢弃也仍是matched。

同源按sourceId绑定以及sourceSha256+textVersion识别别名；历史绑定纳入检查，同源text/analysis或已知review身份改变拒绝。raw没有review身份不被升级，reviewed仍须原reviewRecordId。同ID不同正文/身份拒绝。历史自身不合法或绑定冲突抛INVALID_HISTORY，非法新包抛INVALID_RESULT；材料间可预期冲突则逐整份dropped，不拆refs。

raw同版精确范围去重；同版本、物理共享行逐行完全一致、行数与定位相符且新增历史未覆盖行的独立完整raw窗口，可以与部分重叠旧窗并存。两份正文、SHA、引用、用途、限制及身份原样保留，不拼成并集，不裁掉重复行，也不只按新增行收费。新单窗完整包含旧active raw单窗时仍可整体替换该旧窗；同一新窗可同时替换被包含旧窗、保留部分重叠旧窗，旧窗始终保留账本。必须先核对所有重叠历史项，再作任何变更。混合refs重叠仍整份拒绝；reviewed任何重复历史单元均整份拒绝；同版物理共享行内容矛盾也拒绝。自动项不能覆盖有定位的active手选/内置材料。输入与输出深拷贝隔离。

## 合并口径补充

retained本身不得出现重复ID；输入账本重复、同ID冻结材料被改写、已有源版本或可核对的同版正文相互矛盾，均抛INVALID_HISTORY，不静默修复历史。多个不同ID的既有整份材料仍各自计费，即使内容相同。active总量不受单查6材料限制，但同样不能超过累计账本预算。下一次查询的剩余额度应使用30000-chargedChars，而不是30000-usedChars。

raw替换或重叠并存仅支持新、旧都为单一引用的完整窗口。它必须与所有重叠retained原窗一致，但不必完整包含部分重叠旧窗。共享行按各自lineStart换算位置、逐行比较，空行、空白和Unicode字符不做归一化；不会依据字符串子串猜测位置。标准LF raw头部或直接原文必须能按行数与定位对应，否则以RAW_CONTENT_UNVERIFIABLE拒绝整份重叠材料。混合refs项只要存在raw重复/重叠或reviewed单元冲突就整份拒绝；不抽走冲突引用后接收剩余内容。

历史去重包含精确同范围、旧窗内的子范围，以及已被多个历史raw窗联合覆盖的范围，均返回DUPLICATE_RAW_RANGE；换ID、换sourceId别名或旧窗已退出active不能重领。同次result中先接受的窗口立即进入账本，后续项同样检查。此处联合覆盖仅用于判定是否存在历史未覆盖行，不生成联合正文或合成引用，reviewed覆盖不充当已取得的raw覆盖。

例如同次返回完整raw 1–5行与4–8行，各自原文不超过2400、整份来源总计不超过4800时，若4–5行完全一致，两份均接受且supersedes为空，即使1–8行并集超过2400也不合并。后续再来4–5行是历史重复；若共享行改字、行数不符、版本改变、触及protected或超累计预算，整份拒绝，既有active与账本不动。

coverageGaps是“被拒新材料请求的范围中，当前active引用尚未覆盖的行”，不是新材料引用，也不代表这些行已获取或已采用。它可以为空（例如请求范围完全被当前窗口覆盖）。它不改写result或任何材料正文/refs。

错误码：INVALID_HISTORY、INVALID_RESULT为整体异常。dropped.code包括DUPLICATE_ID、ID_CONFLICT、SOURCE_HASH_CONFLICT、TEXT_VERSION_CONFLICT、ANALYSIS_VERSION_CONFLICT、REVIEW_VERSION_CONFLICT、VERSION_CONTENT_CONFLICT、DUPLICATE_RAW_RANGE、RAW_CONTENT_UNVERIFIABLE、MIXED_REFERENCE_OVERLAP、DUPLICATE_REVIEWED_UNIT、PROTECTED_MATERIAL、CUMULATIVE_BUDGET。PARTIAL_RAW_OVERLAP是旧行为的拒绝码，本版不再仅因物理部分重叠发出它；旧记录不改写。拒绝不更新绑定、不移动active、不追加账本、不收费；继续按result原顺序处理后续整份项。

既有raw没有reviewRecordId不等于已知的另一复核身份；未知不能补造，已知的两条review身份不同才报冲突。raw与reviewed均保留各自原use，新的独立reviewed材料不会修改旧raw用途。手选/内置不被自动替换；有定位的手选/内置窗口与新raw重叠时明确拒绝新份。

## 信任边界与使用

这是纯内存合并器，无存储、网络、模型或密钥访问。所有输入均被视作调用方提供的完整状态；它能发现收到的active/retained不一致，不能凭空发现调用方遗漏了整个历史项或同时改写全部状态后重算哈希。调用方必须从可信checkpoint保留并回传完整账本。它不认证来源登记、不证明额外原文真实，也不代替validateRetrieval绑定实际query；测试通过现有创作validateRetrieval构造合法包，再执行合并。

输出active、retained各份深拷贝，与输入及彼此没有可变共享引用。返回packetId/resultStatus保留实际检索事实；accepted只表示材料进入active上下文，不是创作采用，也不证明补查足够。缺口及拒绝应由创作/UI解释，不能伪造更改检索matched/unavailable状态。
