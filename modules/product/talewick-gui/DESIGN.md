---
name: Talewick Paper Canvas
description: 暖白纸面、手写灵感与清晰文稿的小说创作工作台
colors:
  ink: "var(--tw-ink)"
  canvas: "var(--color-background-full)"
  paper: "var(--tw-paper)"
  accent: "var(--tw-warm)"
  note-rose: "var(--tw-note-rose)"
  note-blue: "var(--tw-note-blue)"
  note-cream: "var(--tw-note-cream)"
  note-sage: "var(--tw-note-sage)"
  text-secondary: "var(--color-text-secondary)"
typography:
  display:
    fontFamily: "Ma Shan Zheng, Songti SC, serif"
    fontSize: "clamp(26px, 2.75vw, 44px)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: ".015em"
  interface:
    fontFamily: "Inter, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  manuscript:
    fontFamily: "Songti SC, Noto Serif CJK SC, STSong, serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 2
rounded:
  control: "8px"
  button-medium: "10px"
  note: "12px"
  panel: "16px"
  home-composer: "20px"
spacing:
  compact: "8px"
  group: "16px"
  section: "24px"
  broad: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button-medium}"
  composer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.home-composer}"
    padding: "24px 24px 20px"
---

# Talewick Paper Canvas

2026-09-07：用户已确认的纸张界面接入当前产品模块。维护位置为 `modules/product/talewick-gui`，视觉来源为 `development/talewick-gui`。旧星图稿与 `Talewick.html` 是历史记录，不作为当前验收标准。

## 视觉与布局

- 暖白点阵画布、手写引导、四色灵感便签，生成后以白纸与宋体正文为主体。
- 颜色来源为 `src/styles/talewick-tokens.css`；页面复用 BoardUI 语义变量、复合字阶、组件及 React Aria 行为。
- 首页引导自托管 Ma Shan Zheng 400，锁定 5.3.1，授权在 `public/licenses/Ma-Shan-Zheng-OFL.txt`。普通界面采用 Inter/PingFang，稿件默认 18px 宋体栈、行高 2，支持 16–24px 设置。
- 桌面导航 72px，1100px 以下 64px。首页为左侧引导、右侧便签、下方输入；桌面输入区距底至少 24px，为真实服务提示留空间。
- 产生稿件后展开可调比例的对话和文稿。900px 以下打开文稿时优先展示文稿；“返回对话”保留来回切换。600px 以下首页自然纵向排列，底部导航高 64px。
- 真实任务进度每个视口只显示一处：桌面对话栏，窄屏打开稿件或展开阅读时在稿件栏。
- 遵照用户选择，创作输入聚焦不增加内外描边；其它控件保留键盘焦点、可访问名称、禁用说明和减少动态效果支持。

## 状态与交互契约

| 表面 | 当前行为 |
| --- | --- |
| 一键成稿 | 提交真实本地任务，显示需求、规划、写作、审稿等实际阶段；不使用定时器模拟完成。 |
| 轻度参与 / 专业审稿 | 明确标注“暂未接通”并禁用；旧项目仍可阅读和编辑。 |
| 任务进度 | 支持取消、按原任务重试、刷新后恢复绑定，以及查看结果与检查报告。 |
| 文稿与审阅 | 新初稿在原稿未变更时落入项目；修改先形成建议，采纳后更新并保留版本；并发人工修改时保留返回结果供查看。 |
| 选段修改 | 携带章节与 UTF-16 起点；后端验证原文并只替换指定范围。重复句不会自动回退到第一处。 |
| 资料和风格 | 本机材料选择与风格规则进入下一次请求快照；没有全库检索或风格训练。 |
| 账号 | 本地界面能力，未连接真实认证。 |
| 视觉样板 | `/design-preview.html` 使用隔离样例展示组件，不读写生产项目，也不发起模型任务。 |

## 维护与验证

`src/features/` 保留产品组合，`src/model/` 保留项目、版本与任务状态；运行契约详见 `RUNTIME.md`。没有新增 Agent 框架，Full15 仍未运行。未配置模型时须如实提示，不能制造稿件或成功进度。

本轮构建、状态测试、HTTP 与浏览器验证记录放在 `runtime-evidence/paper-ui/`。测试使用固定模型替身，仅证明流程和交互接通；不代表文学质量或 Full15 验收。源码和实际测试记录优先于静态样板。
