# 运行与依赖清单

本工具与两种阅读状态适配器的离线操作无需API Key、供应商SDK、Python或第三方npm包。使用仓库要求的Node.js 22.13或更新版本；本次打包核验使用Node.js 24.14.0，未重新验证所有受支持的Node版本。

| 部分 | 运行时依赖 | 保留的相对文件关系 |
| --- | --- | --- |
| 三路协议 | Node内置crypto、fs、util | review-tools.mjs与prompt-templates.json必须同目录；模板通过import.meta.url定位。 |
| 三路适配器 | Node内置assert，以及上述协议模块 | tools/review-preview/src/isolated-reading.mjs引用../../isolated-anchor-reading/review-tools.mjs。 |
| 原连续对读适配器 | Node内置assert；同目录evidence-store.mjs、scoped-review-facts.mjs | evidence-store来自已有公开基线；不要只复制scoped-review.mjs。 |
| 三路合成测试 | Node内置test/assert；上述协议和synthetic-fixture.mjs | 两个工具目录保持仓库位置。 |
| 原连续对读合成测试 | Node内置test/assert；已有continuous-review工具及其synthetic-fixture.mjs | 原协议保持continuous-review-1，不混用新三路计划。 |

协议和模板应当与运行前冻结的版本一起保存；单独替换模板会使原计划重建不匹配。`get/ref`的可信证据存储由调用方提供，适配器不代建可信清单或验证操作者身份。

## 无安装的离线回归

在完整仓库根目录运行，不监听端口、不发送模型请求：

```sh
node --test tools/isolated-anchor-reading/*.test.mjs tools/continuous-review/*.test.mjs tools/review-preview/tests/isolated-reading.test.mjs tools/review-preview/tests/scoped-review.test.mjs
```

## 包含既有预览渲染的完整工具回归

既有preview套件还包含SSR渲染。它需要GUI的锁定npm依赖、BoardUI源码与已构建CSS；它们属于原仓库，不是本次离线协议新增的依赖。

```sh
cd modules/product/talewick-gui
npm ci --ignore-scripts --no-audit --no-fund
npm run build
cd ../../..
node --test tools/review-preview/tests/*.test.mjs tools/continuous-review/*.test.mjs tools/isolated-anchor-reading/*.test.mjs
```

渲染器使用React、react-dom、TypeScript和esbuild。当前package.json固定React/react-dom为19.2.8、TypeScript为5.9.3；esbuild由现有工具链的package-lock.json解析。以同一份锁文件执行npm ci，不要为运行纯离线适配器另装这些包或拷贝node_modules进发布包。

既有preview的构建与监听命令见[预览运行说明](../review-preview/README.md)。三路适配器的视图也可用[单文件离线报告](../review-preview/ISOLATED-REPORT.md)展示。它不依赖 SSR 构建，不需要服务端口，可登记到工作台的评阅历史。

## 维护边界

发布代码保留原始返回、机械契约、人工语义和编辑决定四条独立记录。单稿读感不能变成比较票数；锚点定位、差异覆盖、无措辞警告及测试通过均不能自动认定引文支持主张或全稿通过。

本目录只需要协议源码、模板、合成样例、测试和说明。稿件、实际请求、真实回包、调用回执、执行账本和本地预览产物由调用方在仓库外保管；不要放入本工具目录。


当前公开协议为isolated-anchor-reading-2，buildReadingPlan需要显式chapterIds；检查、执行和展示记录使用对应v2 schema。旧连续对读依赖不变，旧isolated-anchor-reading-1仅可由原冻结工具单独重放，本包不内置静默兼容层。

公共JSON允许清单仅新增本目录的prompt-templates.json；CI分别运行新协议测试与适配器测试。发布增量不包含node_modules、dist或任何指向本机的符号链接。完整SSR回归在开发环境安装锁文件依赖并构建GUI后运行，这些构建产物不随源码发布。
