# Talewick 工作台

从仓库根目录进入本目录，使用 Node.js 22.13+：

```sh
npm ci
cp .env.example .env.local
# 编辑 .env.local，填写模型地址、模型名和自己的 API Key
npm run build
npm start
```

打开 http://127.0.0.1:4326。首次启动是空资料库，不附带内部小说样本或拆解结果。可以先无资料写作，也可以导入自己有权使用的 TXT/Markdown。

默认使用 `ai-sdk` 创作引擎，需要支持工具调用的模型。`TALEWICK_ENGINE=fixed` 仅改变新创作任务的执行路径，不能据此假定对话入口无须工具调用。任务默认保存在 `.local-runs/`，配置在 `.env.local`；两者均不提交。

开发时另开终端运行 `npm run dev -- --port 4323`。Vite 的 API 代理指向 4326。检查命令为 `npm run test:runtime`、`npm run test:ui` 和 `npm run build`。

使用与限制见仓库根目录 [中文说明](../../../README.md) / [English](../../../README.en.md)，开发规则见 [AGENTS.md](AGENTS.md)。
