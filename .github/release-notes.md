## HachimoDock-beautiful 0.1.245-rc.1

HachimoDock 的**非官方构建分支**的第一个候选版本，由本仓库 GitHub Actions 从 `main` 源码构建。运行时（LGPL FFmpeg 8.1.3、Node 26.7.0）全部经过源码仓库的许可/审计门禁。

> 非官方分支，与上游作者无隶属或背书关系；按上游许可要求标注为修改版本。需要官方版本请前往 [ai-maker-lab/HachimoDock](https://github.com/ai-maker-lab/HachimoDock/releases)。

### 本次包含

- **更新提醒**：新版本发布满 12 小时后，客户端启动时弹窗展示更新内容，可当场下载安装；同一版本只提醒一次。
- **设置页整理**：「外观」与「应用更新」合并进「其他配置」分组。
- **应用内更新**：设置页可检查版本、查看发布说明、应用内下载（进度 + 镜像回退）并启动安装；macOS 引导到发布页。
- **四平台安装包**：Windows x64 / arm64（NSIS）、macOS arm64 / x64（DMG）。
- 本分支既有的 Prism / ZCode 支持、多服务商语音、Liquid Glass 双主题界面、天气数据源，以及上游 0.1.245 的 Devin/Hermes、Wi-Fi 配对、联网检索等能力。

完整软件更新见仓库根目录 [CHANGELOG.md](https://github.com/laochenfei233/HachimoDock-beautiful/blob/main/CHANGELOG.md)。

### 安装包

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `HachimoDock_0.1.245-rc.1_Windows-x64-setup.exe` | NSIS，未做 Authenticode 签名 |
| Windows x64 | `HachimoDock_0.1.245-rc.1_x64_en-US.msi` | MSI，版本号回退为基础版本 `0.1.245`（WiX 不接受预发布版本） |
| Windows arm64 | `HachimoDock_0.1.245-rc.1_Windows-arm64-setup.exe` | NSIS，arm64 设备 |
| macOS arm64 | `HachimoDock_0.1.245-rc.1_macOS-arm64.dmg` | Apple silicon，ad-hoc 签名、未公证 |
| macOS x64 | `HachimoDock_0.1.245-rc.1_macOS-x64.dmg` | Intel，ad-hoc 签名、未公证 |
| 校验 | `SHA256SUMS` | 上述文件的 SHA-256 |

macOS 包未公证，首次打开需在「系统设置 → 隐私与安全性」中放行。
