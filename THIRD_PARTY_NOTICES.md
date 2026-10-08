# Third-party notices / 第三方声明

Talewick's original software is licensed under AGPL-3.0-only. Third-party components keep their original terms; this project does not relicense them.

- **BoardUI**: source-owned components under `modules/product/talewick-gui/src/components/` and associated theme/styles/utilities are based on the public free BoardUI source. Copyright (c) 2026 Mertcan Dundar Esmergul (BoardUI). [MIT text](licenses/BoardUI-MIT.txt). [Upstream](https://github.com/BoardUI/boardui). Local component paths were checked against the public source tree; product adaptations remain in place. No Pro components are intentionally included.
- **Inter** and **Ma Shan Zheng**: installed through Fontsource, licensed under SIL OFL 1.1. See [Inter](licenses/fontsource-inter-LICENSE) and [Ma Shan Zheng](licenses/fontsource-ma-shan-zheng-LICENSE). Fonts are bundled during the local build.
- **Remix Icon**: pinned to `@remixicon/react@4.6.0` (Apache-2.0), rather than later versions with different terms. [License text](licenses/RemixIcon-Apache-2.0.txt). [Upstream](https://github.com/Remix-Design/RemixIcon).
- Other npm dependencies, including React, React Aria, AI SDK, Tailwind CSS, and Motion, are installed from the pinned lockfile. Their license files and notices remain with their packages. The repository does not include `node_modules` or built bundles.

Reading examples in `examples/` are excluded from the software AGPL grant; see their README. No private source corpus, private analysis library, or historical runtime data is distributed.
