<p align="center"><img src="assets/hachimodock-mark.png" width="132" alt="HachimoDock 橙色猫形象标识" /></p>

<h1 align="center">HachimoDock-beautiful</h1>

<p align="center">
  <a href="https://github.com/ai-maker-lab/HachimoDock"><img alt="fork of ai-maker-lab/HachimoDock" src="https://img.shields.io/badge/fork-ai--maker--lab%2FHachimoDock-orange" /></a>
  <img alt="installers: Windows x64/arm64, macOS arm64/x64" src="https://img.shields.io/badge/installers-Windows%20%2B%20macOS-2ea44f" />
  <img alt="license: HachimoDock Project License 1.0, non-commercial" src="https://img.shields.io/badge/license-HachimoDock%201.0%20non--commercial-blue" />
  <a href="https://github.com/laochenfei233/HachimoDock-beautiful/actions/workflows/build-installers.yml"><img alt="build workflow status" src="https://github.com/laochenfei233/HachimoDock-beautiful/actions/workflows/build-installers.yml/badge.svg" /></a>
</p>

<p align="center">HachimoDock 的非官方分支：在公开审计链路上构建 Windows / macOS 四个平台的安装包，并内置应用内更新与更新提醒。</p>

## 这不是官方版本

- 本仓库是 [HachimoDock](https://github.com/ai-maker-lab/HachimoDock) 的**个人非官方分支**，与上游作者无隶属、合作或背书关系。
- 依据上游许可证第 4、5 条，本分支明确标注为修改版本，不冒充官方发布；品牌与标识不随源码授权。
- 安装包由本仓库的 GitHub Actions 从本分支源码构建，**没有**上游的签名与公证（见「平台支持」）。
- 需要官方版本请前往 [上游 Releases](https://github.com/ai-maker-lab/HachimoDock/releases)。

## 功能

HachimoDock 本体是连接桌面小屏的宠物伴侣与 Agent 状态看板。本分支在此基础上：

- **应用内更新**：设置页「其他配置 → 应用更新」查询本仓库 Releases，显示发布说明，可直接下载安装包（带进度、支持网络镜像回退）并启动安装器；不支持应用内安装的平台引导到发布页。
- **更新提醒**：新版本发布满 12 小时后，启动客户端会弹窗展示版本与更新内容，可当场安装；同一版本只提醒一次，选「稍后提醒」后不再打扰。
- **四平台安装包**：Windows x64 / arm64 与 macOS arm64 / x64 均由流水线构建并发布到 Releases，附 `SHA256SUMS` 校验。
- **更多桌面 Agent**：在 Codex、Claude、WorkBuddy、DeepSeek Harness 之外，支持 ZCode（状态跟随 + 可见输入框语音 + 任务派发）、Prism（可见输入框语音与任务派发，会话切换经其桥接插件）、Devin 与 Hermes Agent。
- **多服务商语音**：识别与合成可分别选择豆包、通义千问、MiMo 或自定义兼容端点，支持跨服务商组合；凭据按服务商隔离，切换不串用；形象可单独指定合成服务商。
- **联网检索与天气**：实时对话可按需联网检索（含 DeepSeek 搜索源与独立 Key）；天气数据源支持和风与彩云，密钥只进系统凭据库。
- **Wi-Fi 配对**：WiFi6 板型可在同一局域网内配对，支持状态跟随、实时对话、无线组件安装与固件升级。
- **界面**：Liquid Glass 风格浅色 / 深色 / 跟随系统三态主题，橙色猫形象贯穿图标与侧边栏；系统开启「减少动态效果 / 降低透明度」时自动降级。

完整逐条记录见 [CHANGELOG.md](CHANGELOG.md) 与 [最新发布说明](https://github.com/laochenfei233/HachimoDock-beautiful/releases/latest)。

## 快速开始

**装起来用**：前往 [Releases](https://github.com/laochenfei233/HachimoDock-beautiful/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `HachimoDock_*_Windows-x64-setup.exe`（NSIS）或 `*_x64_en-US.msi` |
| Windows arm64 | `HachimoDock_*_Windows-arm64-setup.exe` |
| macOS arm64 | `HachimoDock_*_macOS-arm64.dmg` |
| macOS x64 | `HachimoDock_*_macOS-x64.dmg` |

Windows 安装器未做 Authenticode 签名；macOS 包为 ad-hoc 签名且未公证，首次打开需在「系统设置 → 隐私与安全性」中放行。

**自己触发一次构建**（构建成功后会自动创建 Release 并上传安装包）：

```sh
gh workflow run build-installers.yml --repo laochenfei233/HachimoDock-beautiful
gh run watch --repo laochenfei233/HachimoDock-beautiful
```

构建全部在 GitHub 托管 runner 上完成，本地不需要 Windows 或 macOS 环境。每次构建的原始产物也保留在 Actions → Artifacts。

## 构建流水线

流水线只信任可核验的输入：LGPL FFmpeg 与 Node 运行时来自**官方已发布安装包**或**经 SHASUMS 校验的官方分发**，并按源码中的审计表逐字节校验；校验不过就不出包。

```mermaid
flowchart LR
  A["main 源码"] --> C["Actions runner<br/>windows / macos / ubuntu"]
  B["官方 v0.1.245 安装包<br/>与官方 Node 分发"] --> C
  C --> D{"审计门禁<br/>SHA-256 / 固定配方"}
  D -->|"通过"| E["Tauri 构建<br/>NSIS / MSI / DMG"]
  D -->|"不通过"| G["停止并留证<br/>不产包"]
  E --> H["Actions Artifact"]
  E --> I["GitHub Release<br/>+ SHA256SUMS"]
```

审计表在源码 `pc/scripts/prepare-desktop-resources.mjs`，两种形态并存：`windows-x64`、`windows-arm64` 固定二进制 SHA-256；`macos-x64` 因链接产物不可位级复现，改为「审计源码包 + 逐字固定的 configure 配方」评审。这是安全门禁，不是可以绕过的构建开关。

## 平台支持

四个目标都由本仓库的流水线真实构建：

| 目标 | 说明 |
|---|---|
| Windows x64 | NSIS + MSI。运行时直接取自官方安装包内已审计副本 |
| Windows arm64 | NSIS。FFmpeg 由 llvm-mingw 从审计源码包交叉编译（静态 CRT），Node 取官方 win-arm64 分发 |
| macOS arm64 | DMG。运行时取自官方 v0.1.245 dmg |
| macOS x64 | DMG。FFmpeg 在 macOS runner 上从审计源码包交叉编译（VideoToolbox），Node 取官方 darwin-x64 分发 |

MSI 的元数据版本回退为基础版本（WiX 不接受 `-rc.N` 之类的预发布版本），安装包内应用版本仍以源码版本为准。

## 许可证

本分支沿用上游的 [HachimoDock 项目许可证 1.0](LICENSE)：源码可见但**不是** GPL、MIT 或其他标准开源许可，仅授权非商业使用；再分发必须附带许可证并保留版权声明；修改版本必须清楚标注修改事实，不得暗示官方版本。第三方组件、字体与素材继续适用其各自许可证。

## 致谢

上游项目 [ai-maker-lab/HachimoDock](https://github.com/ai-maker-lab/HachimoDock)：连接设备的宠物形象、任务气泡与语音交互体验都来自上游。本分支只做构建自动化与界面 / 集成方面的个人改动；原始上游说明见 [docs/README-upstream.md](docs/README-upstream.md)。
