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

先看各路是否有原件，再看协议和绑定，接着核读具体引文能否支持该主张。两路单稿没有比较票。比较路的原始偏好与机械有效偏好分列。人工复核只针对记录的范围；最后的编辑决定另行登记，生成报告不会采纳稿件，也不会改变默认 GUI 或认定整稿通过。
