<p align="center"><img src="assets/hachimodock-mark.png" width="132" alt="HachimoDock 橙色猫形象标识" /></p>

<h1 align="center">HachimoDock-beautiful</h1>

<p align="center">
  <a href="https://github.com/ai-maker-lab/HachimoDock"><img alt="fork of ai-maker-lab/HachimoDock" src="https://img.shields.io/badge/fork-ai--maker--lab%2FHachimoDock-orange" /></a>
  <img alt="installers: Windows x64" src="https://img.shields.io/badge/installers-Windows%20x64-2ea44f" />
  <img alt="license: HachimoDock Project License 1.0, non-commercial" src="https://img.shields.io/badge/license-HachimoDock%201.0%20non--commercial-blue" />
  <a href="https://github.com/laochenfei233/HachimoDock-beautiful/actions/workflows/build-installers.yml"><img alt="build workflow status" src="https://github.com/laochenfei233/HachimoDock-beautiful/actions/workflows/build-installers.yml/badge.svg" /></a>
</p>

<p align="center">HachimoDock 的非官方构建分支：在公开审计链路上产出 Windows 安装包，并为应用内「应用更新」面板提供发版渠道。</p>

## 这不是官方版本

- 本仓库是 [HachimoDock](https://github.com/ai-maker-lab/HachimoDock) 的**个人非官方分支**，与上游作者无隶属、合作或背书关系。
- 依据上游许可证第 4、5 条，本分支明确标注为修改版本，不冒充官方发布；品牌与标识不随源码授权。
- 安装包由本仓库的 GitHub Actions 从本分支源码构建，**没有**上游的签名与公证（见下方「平台支持现状」）。
- 需要官方版本请前往 [上游 Releases](https://github.com/ai-maker-lab/HachimoDock/releases)。

## 这个仓库里有什么

本仓库即 HachimoDock 的完整源码分支（含全部提交历史），在同步上游 0.1.245 的基础上包含本地功能改动与构建流水线：

| 内容 | 位置 | 说明 |
|---|---|---|
| 完整源码与历史 | 本仓库 main 分支 | 与上游 0.1.245 同步，叠加本地功能改动；原始上游说明见 [docs/README-upstream.md](docs/README-upstream.md) |
| 构建流水线 | `.github/workflows/build-installers.yml` | Windows x64 出包；macOS / Windows arm64 在门禁处留证（见「平台支持现状」） |
| 安装包产物 | Actions → 运行记录 → Artifacts | 每次成功构建产出 NSIS 安装器与 MSI，保留期以 GitHub 默认策略为准 |

## 快速开始

**只想装起来用**：打开 [Actions 构建记录](https://github.com/laochenfei233/HachimoDock-beautiful/actions/workflows/build-installers.yml)，进入最新一次成功运行，在页面底部下载 `windows-x64-installers`，解压后运行 NSIS 安装器（未做 Authenticode 签名，系统可能提示未知发布者）。

也可以用 GitHub CLI 下载最近一次构建产物：

```sh
gh run download --repo laochenfei233/HachimoDock-beautiful --name windows-x64-installers
```

**想自己触发一次构建**：

```sh
gh workflow run build-installers.yml --repo laochenfei233/HachimoDock-beautiful
gh run watch --repo laochenfei233/HachimoDock-beautiful
```

构建全部在 GitHub 托管 runner 上完成，本地不需要 Windows 或 macOS 环境。

## 构建流水线

流水线只信任可核验的输入：源码包来自本仓库 Release，LGPL FFmpeg 与 Node 运行时从**官方已发布安装包**里抽取，并按源码中的审计表逐字节校验 SHA-256；校验不过就不出包。

```mermaid
flowchart LR
  A["本地 main<br/>git archive"] --> B["Release ci-src<br/>源码包 tar.gz"]
  B --> C["Actions runner<br/>windows-latest / macos-15"]
  C --> D["从官方 v0.1.245 安装包<br/>抽取 FFmpeg 与 Node"]
  D --> E{"SHA-256 与审计表一致?"}
  E -->|"是"| F["npm ci<br/>Tauri 构建"]
  E -->|"否"| G["记录证据<br/>不产包"]
  F --> H["NSIS / MSI / DMG<br/>Actions Artifact"]
```

审计表在源码 `pc/scripts/prepare-desktop-resources.mjs` 的 `auditedFfmpegBinarySha256` 中，目前只有两项：`windows-x64` 与 `macos-arm64`。这是安全门禁，不是可以绕过的构建开关。

## 平台支持现状

四个目标都由本仓库的流水线真实构建，运行时全部经过源码审计门禁（缺失的审计条目已随构建结果补录）：

| 目标 | 状态 | 说明 |
|---|---|---|
| Windows x64 | 可构建 | NSIS + MSI。官方安装包内的已审计运行时直接抽取 |
| Windows arm64 | 可构建 | NSIS。FFmpeg 由 llvm-mingw 从审计源码包交叉编译（静态 CRT，PE 无时间戳），Node 取官方 win-arm64 分发（SHASUMS 校验） |
| macOS arm64 | 可构建 | DMG（ad-hoc 签名，未公证）。运行时取自官方 v0.1.245 dmg |
| macOS x64 | 可构建 | DMG。FFmpeg 在 macOS runner 上从审计源码包交叉编译（VideoToolbox），Node 取官方 darwin-x64 分发（SHASUMS 校验） |

审计门禁分两种形态： 与  固定二进制 SHA-256； 因 ld64 输出不可位级复现，改为「审计源码包 + 逐字固定的 configure 配方」评审。macOS 安装包为 ad-hoc 签名且未公证，首次打开需在系统设置中放行。

## 相对上游的改动

本分支在同步上游 0.1.245 的基础上，主要包含：

- **应用更新面板**：设置页新增「应用更新」卡片，查询本仓库 Releases，显示发布说明，支持应用内下载与启动安装器；发布与否由本仓库的 Release 决定。
- **桌面 Agent 扩展**：在 Codex、Claude、WorkBuddy、DeepSeek Harness 之外，增加 Prism 与 ZCode 的状态跟随与当前可见输入框语音草稿；Prism 的设备气泡选择经其桥接插件切换桌面对话。
- **多服务商语音**：语音识别与语音合成可分别选择豆包、通义千问、MiMo 或自定义兼容端点，凭据按服务商隔离，切换不串用。
- **界面改版**：Apple 风格浅色/深色双主题（跟随系统），橙色猫形象贯穿图标、侧边栏与 favicon。

上述改动的设计与验收记录随源码包一起提供（`docs/compose/specs/`）。

## 许可证

本分支沿用上游的 [HachimoDock 项目许可证 1.0](LICENSE)：源码可见但**不是** GPL、MIT 或其他标准开源许可，仅授权非商业使用；再分发必须附带许可证并保留版权声明；修改版本必须清楚标注修改事实，不得暗示官方版本。第三方组件、字体与素材继续适用其各自许可证。

## 致谢

上游项目 [ai-maker-lab/HachimoDock](https://github.com/ai-maker-lab/HachimoDock)：连接设备的宠物形象、任务气泡与语音交互体验都来自上游。本分支只做构建自动化与界面/集成方面的个人改动。
