# 评阅证据展示适配器

`openEvidenceStore(root, trustedSHA256)` 读取在可信上下文中登记的清单摘要。调用方传入可信摘要，清单内的每项注册稿对、来源、类型、相对路径和文件摘要。`adaptResult(store)` 核对来源报告与统筹结论中的稿对和来源，再生成展示用 JSON。`ResultEvidencePanel` 接收该 JSON 和 `labels`。它复用项目中的 BoardUI Badge、ButtonLink、语义颜色和复合字阶。

`tests/fixture.mjs` 提供一个完整的双来源合成包。`reportId: null` 表示该来源尚未送入评阅结果，`conclusionId: null` 表示人工复核、文学判断和采纳建议均待定。原始来源只要有一个引用失败，汇总就保留失败。服务端通过真实基线和候选文件的字节摘要绑定稿对。来源归属由编制白名单的可信操作者核定，通用加载器不替代人工判断。

先在 `modules/product/talewick-gui` 安装锁定依赖并执行 `npm run build`。进入 `tools/review-preview` 后运行 `node --test tests/*.test.mjs` 检查合成包和回环 HTTP 服务。仅运行无监听部分用 `node --test tests/result.test.mjs`。构建用 `node src/build-preview.mjs BUNDLE TRUSTED_SHA NEW_OUTPUT GUI [GUI_WITH_DEPENDENCIES]`，其中 GUI 提供项目组件与已编译 CSS，依赖目录提供已有 React、TypeScript 和 esbuild。构建会做严格类型检查和静态渲染。输出目录须尚不存在，构建工具也会在其父目录生成 `render-preview.cjs` 供合成渲染验证。

使用 `node src/serve.mjs SITE TRUSTED_SITE_SHA 4965` 打开本地只读服务。HTTP 请求只查找构建时登记的路由。浏览器可使用证据 ID 和 SHA256 下载已校验的文件。文件系统路径、其他来源、符号链接、字节变动和未登记入口均受检查。

集成时把 `evidence-store.mjs` 与 `result-adapter.mjs` 放在服务端同一目录。前端使用 `ResultEvidencePanel.tsx`，由服务端传入视图与标签。默认产品评审接入口由统筹另行集成和回归。
