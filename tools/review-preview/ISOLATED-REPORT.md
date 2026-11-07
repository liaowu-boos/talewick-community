# 离线查看三路评阅
从仓库根目录运行以下命令，然后用浏览器打开生成的 HTML。不需要 API Key、npm 安装或本地服务。输出文件须尚不存在。

```sh
node tools/review-preview/isolated-report-demo.mjs reading-demo.html
```

这是合成示例。S1 的非 JSON 回包仍能展开原文和失败原因；S2 格式通过，但“访客拿走钥匙”的主张只引用了靠伞的动作，示例中的人工复核记录判为不支持。展开“事实主张与冻结原句”，可以看见这条主张的引文来自哪一稿、哪一章。C1 没有回包，不据此判断请求是否发出。

**把自己的记录交给渲染器。** CLI 只演示内置数据。应用接入时使用和[三路适配器](ISOLATED-READING.md)相同的可信输入，将可直接打开的 HTML 写到新的私有文件：

```js
import {writeFile} from 'node:fs/promises';
import {renderIsolatedReport} from './tools/review-preview/src/isolated-report.mjs';

// adapterInput 由调用方从已冻结、经核验的计划与证据清单取得。
const html = renderIsolatedReport(adapterInput);
await writeFile('local-review.html', html, {flag:'wx', mode:0o600});
```

输入包括预登记计划摘要、对应计划、已核验阅读清单和证据库 get/ref。渲染器调用适配器重建并核对结果；不要把任意 JSON 或旧版评阅当作已核验输入。可运行的[磁盘证据库接入例](tests/isolated-report-store.test.mjs)演示了如何读取已登记的材料，并拒绝字节被替换的回包。实际报告含原始回包和所引用的私有文字，请按原材料权限保管。

先看各路是否有原件，再看协议和绑定，接着核读具体引文能否支持该主张。两路单稿没有比较票。比较路的原始偏好与机械有效偏好分列。人工复核只针对记录的范围；最后的编辑决定另行登记，生成报告不会采纳稿件，整稿验收由编辑单独记录。

## 从工作台的评阅历史打开

打开作品的文稿区，展开「独立全文评阅 → 评阅历史」，选择「打开三路报告」。保存或撤回正在编辑的正文后，工作台核对当前项目与完整稿件版本。对应其他版本的记录会提示切换版本。打开时服务端重新核对题名、章节 ID、章序、章名、正文和已登记报告文件的摘要。

评阅工具可以在生成冻结结果后调用 `registerWorkbenchReport`，输入可信的项目 ID、整稿快照、明确的匿名侧 A/B、评阅时间和渲染器输入。现有本机证据库可从仓库根执行以下导入，用与工作台相同的本机运行目录。

```sh
node tools/review-preview/import-workbench-report.mjs BUNDLE STORE_SHA256 PLAN_SHA256 RUNS_DIR
```

在冻结 `review-evidence-manifest-1` 时，把下列登记信息作为 `workbenchReport` 写入清单。两个命令行摘要分别来自可信的证据库登记和调用前的计划登记。旧清单可另存为新登记并固定新的清单摘要，保留原件。

```json
{"projectId":"paper","sourceId":"reader","planId":"plan","readingId":"reading","baselineVersion":"A","target":"baseline","createdAt":"2026-01-01T00:00:00.000Z","synthetic":true}
```

`baselineId` 和 `candidateId` 对应各自的完整 JSON 稿件，含 `title` 与有序 `chapters`。两稿须与 v2 计划中对应侧的全部章节相符。选章档案需要另行建立可信的整稿绑定后才能用于该入口。`target` 可取 `baseline` 或 `candidate`。`planId`、`readingId` 和阅读清单引用的原件须登记为同一 `sourceId` 的 evidence。登记完成后重新打开作品即可查看。完整可运行的导入、错版与篡改用例见[工作台回归测试](tests/workbench-report.test.mjs)。
