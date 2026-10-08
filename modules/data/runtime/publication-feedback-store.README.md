# 发布复盘存储 v1

`await createPublicationFeedbackStore({rootDir})` 创建一个独立单写入者服务。rootDir 必须是专属发布反馈目录，不能指向小说库。只使用该目录的 `catalog.json` 保存业务数据，`owner.json`/`owner-recovery`用于进程锁；不调用模型、不访问网络、不生成示例记录。

接口遵守 publication-feedback-r01 合同：listPublications/getPublication/createPublication/addObservation/addReview/addDecision/close 均异步。追加接口第三参必须为 `{expectedRevision}`。每次追加revision加1，不改原稿或旧事件；同workId可创建不同独立记录。失败使用带code/status/message的Error，输入400、不存在404、版本冲突409，存储损坏/不可用503。

正文逐字保存并计算UTF-8 SHA256，chars为JS字符串长度；普通录入文字trim。正文引文和证据绑定不进行自动修补。日期接受带Z/时区偏移的ISO时间，指标缺省null，零值保留；不修正completions>reads或reads>impressions，也不在DATA推算文学效果。

写事务串行且复制输入，只有原子rename成功才更新内存。写盘失败保留此前内存；目录重开检查结构、正文hash、版本计数、ID唯一性、复盘与决策绑定。不可读/损坏catalog不覆盖，启动失败释放本进程锁。只接管已明确退出PID的旧锁。close等待已接受写事务完成，然后释放锁。

复盘输入接收CREATION的 `{status,textSha256,observedRevision,inputHash,report?,error?,rawResponse?}`，当前revision及正文SHA必须匹配，且已有观察。report按共同结构检查，并核对本稿观察ID与逐字引文；语义解释仍由CREATION/VALIDATION负责。failed.error使用 `{code,message}`；code限安全标识，message统一替换为中文安全提示，不回传provider配置。rawResponse可留内部catalog（最多1000000字符），所有返回Publication副本均剔除它，列表仅返回身份/正文hash等摘要及历史数量，不返回正文或模型报告。getPublication用于导出完整可见业务历史，内部排障原响应不进入前端导出。

addDecision是服务内部接口，必须传VALIDATION.evaluateDecision的结果：合同Decision字段加 `status/limitations/evidenceBindings`，不得直接转发浏览器对象。DATA不自行运行可比性、两部后续作品或反例门槛算法：这些业务判断由VALIDATION拥有。DATA检查reviewId/hypothesisId、基本结构，按action及result.conclusion推导状态并要求评估状态一致；单独的status或缺评估字段输入被拒绝。adopt还须scope/reason及非空绑定。此结构检查不是跨模块验证算法的替代，PRODUCT必须先调用evaluateDecision。evidenceBindings接受有界JSON对象或数组并冻结存储，不重新读取后续作品来覆盖过去依据。

单记录每种历史最多10000项，总发布记录最多10000项；输入正文120000 JS字符、普通备注4000、标识200，指标须非负安全整数。报告和绑定限定JSON深度/数组规模/存储长度。超过限制明确拒绝，不截断内容。后续如需扩大容量，应另作版本化迁移，不直接改旧数据。

定向验证：`node --test modules/data/tests/publication-feedback-store.test.mjs`。仅合成短稿/假账号/假数据、临时目录和已退出本地子进程，不调用DeepSeek或其它生成API。

## 共同合同 r02 增量

创建输入与Publication新增workIdentityConfirmed/accountIdentityConfirmed，缺省false，显式值必须为boolean。它们是用户声明，不代表平台认证；workId应跨版本/平台保留同一作品身份，account应为平台唯一账号标识。DATA仍允许独立登记同正文或同作品的发布记录，独立作品/正文hash采用门槛由VALIDATION判断。

Observation新增windowKind，缺省unknown，只接受unknown/since_publication。DATA保留全部原始快照（包括倒序补录、同时间冲突）；不排序覆盖，不推断当前快照。自发布累计窗口与时间差的一致性、未来观察排除、同时间冲突及比较限制由VALIDATION统一计算。

record_result/adopt须提供planDecisionId，且必须指向本Publication同reviewId/hypothesisId的已保存plan_test。当前有效计划选择、旧计划支持不可挪用、计划前发布稿不可计支持均由VALIDATION执行。plan.criterion为可选有界对象：kind只接受increase/decrease/at_least/at_most/approved，value若提供须为有限number；缺value或只存自由文字可继续准备，但不可据此绕过VALIDATION的判据核验。criterionCheck及结构化适用范围保存在evidenceBindings内，不增加顶层字段，已有冻结绑定不回写。

模型每个hypothesis的alternatives/limitations和report.limitations均至少一项，每项trim后非空。不因这些字段合规认定原因查明。

r02未部署且无真实旧记录，按补充合同不实现r01目录迁移；不应把旧合成目录交给新服务自动改写。本轮只运行 `node --test --test-name-pattern='r02 ' modules/data/tests/publication-feedback-store.test.mjs`，4项新增测试通过，没有重复执行已通过的12项r01测试。
