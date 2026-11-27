---
feature: liquid-glass-ui-overhaul
status: in-progress
updated: 2026-11-27
branch: feat/liquid-glass-ui
commits: 9be9948..(delivery)
---

# Liquid Glass UI 全站精修 + 启动 Splash

## Report

（交付时回填）

## [S1] Problem

1. **启动白窗**：`desktop_window::fit(app, true)` 在 Tauri setup 同步段末尾即 `window.show()`（desktop_window.rs:186），此时 WebView2 才开始加载前端、React 未挂载——用户在启动后数秒内看到无内容的白窗，感知为「卡住、白屏」。
2. **材质层次单一**：现有 Apple 风格 token（Liquid Glass 浅/深/跟随三态）已有玻璃基底，但页面级材质缺乏 iOS 26 液态玻璃的分层（Light/Medium/Heavy）、顶部高光与边缘反射、真实景深阴影层级；各页观感平、悬浮关系弱。

## [S2] Design

### S2.1 Splash 启动窗（白屏修复）
- 新增 `pc/splash.html`：独立 vite 入口（rollupOptions.input），零 JS、内嵌 CSS——橙猫 logo（现有 hachimodock-mark.png 资源）呼吸动画（scale 1→1.04，2s ease-in-out 交替）+ 三个加载点（stagger 150ms）。深浅色跟随 `prefers-color-scheme`。
- `tauri.conf.json` windows 数组新增 `splash` 窗口：约 320×360、`transparent:true`、`decorations:false`、`resizable:false`、`center:true`、`visible:true`、`url:"splash.html"`；`main` 窗保持 `visible:false`。
- Rust 新命令 `desktop_window_ready`：前端首帧 paint 后 invoke——`MAIN_SHOWN` 原子置位、`fit(app,false)` + `window.show()` + `set_focus()`、关闭 splash 窗口。幂等（重复调用无害）。
- 兜底：setup 里 spawn 15s 守护——若 `MAIN_SHOWN` 未置位（前端异常未能 invoke），强制 show 主窗并关 splash，避免永久黑窗。
- 主窗首帧做一次 240ms fade-in（signature 的一部分），`prefers-reduced-motion` 时跳过。

### S2.2 Token 层（styles.css）
- 新增材质 token（浅/深两套，深色挂 `[data-theme=dark]`）：
  - `--glass-light`（5–6% 白/深灰底 + blur(20px)）、`--glass-medium`（62–72% 底 + blur(40px) saturate(160%)）、`--glass-heavy`（76–86% 底 + blur(60px) saturate(180%)）——每项含 background/border/backdrop-filter 三值组合。
  - `--glass-highlight`（::before 顶部 180° 高光渐变）、`--glass-edge`（::after 1px 内描边高光）。
  - `--shadow-xs/sm/md/lg` 四级景深（现有 --shadow-xs 保留名）。
  - 动效：`--ease-default`、`--ease-spring`、`--dur-quick(150ms)/--dur-move(220ms)/--dur-layer(300ms)`。
- 既有 token 名（--surface/--line/--shadow-* 等）全部保留为别名/重定义，禁止大面积机械替换页面内旧引用。
- 性能纪律：每屏可见 backdrop-filter 元素 ≤ 12；长列表行不加 blur（半透明底替代）；glass 卡加 `contain: paint`；不做 hover 时的 blur 值动画。

### S2.3 壳精修
- 侧栏：medium glass + 顶部高光；品牌区橙猫 logo 保留；导航项 hover 微玻璃底、active 橙 accent 玻璃胶囊（现有 is-active 样式升级）。
- ContextRail / 顶栏 / PageShell 头部：边缘高光 + 分层阴影。

### S2.4 逐页精修清单（每页独立提交，浅/深双主题自评）
1. **桌宠伙伴（home/dashboard）**：Agent 行卡 medium glass、形象缩略卡玻璃化、跟随态/检测态胶囊、LanAgentSessionFeed 事件列表玻璃行。
2. **设备初始设置（DeviceSetup）**：向导卡 heavy glass、步骤指示玻璃胶囊。
3. **形象画廊（gallery）**：网格卡 hover 提升（translateY(-2px) + shadow-md）、工具条玻璃化。
4. **形象向导（wizard）**：分步容器 heavy glass、上传/拖放区虚线玻璃。
5. **形象详情（detail）**：hero 面板 medium glass、操作按钮体系统一。
6. **组件中心（components）**：组件卡 glass + 类型徽标玻璃胶囊、网格 hover、移除/同步按钮层级。
7. **模型配置（api）**：provider 卡 medium glass、分段控件玻璃胶囊、凭据输入玻璃输入框、探测结果列表、语音卡（ASR/TTS 两卡）精修。
8. **键盘配置（keyboard）**：键位映射卡玻璃化、按键胶囊。
9. **其它设置（settings）**：设置分组卡、开关控件、AppUpdateCard 玻璃化。
10. **弹窗体系**：modal-backdrop（blur(8px)+40% 遮罩）、modal-card heavy glass + spring 入场；PersonaVoiceModal / FormosaPicker / FollowAgentConfirm / AppUpdateNotice / 退出确认统一。

### S2.5 动效纪律（克制 + 一处 signature）
- 交互动效仅：hover（translateY/底色 220ms）、按压 scale(0.98,150ms)、弹层入场（300ms spring）、弹窗内小列表 stagger（30ms）。
- signature：splash logo 呼吸 + 主窗首帧 240ms fade-in。页面间不加过渡。
- 全部动效包裹 `@media (prefers-reduced-motion: reduce)` 降级（animation/transition 0.01ms）。

### S2.6 可访问性
- 玻璃上的正文对比度 ≥ 4.5:1（浅色玻璃用 rgba(0,0,0,.85) 文本，深色玻璃 rgba(255,255,255,.95)）；焦点可见（accent 2px outline）。
- 按钮最小热区 32px（桌面密度沿用现有）。

## [S3] Scope
- In：上述 9 视图 + 壳 + 弹窗体系 + splash；浅/深双主题；token 层。
- Out：固件端 UI；组件内嵌 widget 预览的像素风；任何功能行为变更；除 splash 外的新页面；macOS 专属窗口镀铬。

## Tasks
- [ ] T1 splash 白屏修复（covers: S2.1）
- [ ] T2 token 层 + 壳精修（covers: S2.2, S2.3）
- [x] T3 弹窗体系统一——由 T2 的 modal-card/modal-backdrop 基类改造覆盖（heavy glass + sheen + spring 入场 + blur 遮罩），各特例弹窗均继承基类（covers: S2.4.10）
- [ ] T4 桌宠伙伴 + DeviceSetup（covers: S2.4.1-2）
- [ ] T5 画廊 + 向导 + 详情（covers: S2.4.3-5）
- [ ] T6 组件中心（covers: S2.4.6）
- [ ] T7 模型配置（covers: S2.4.7）
- [ ] T8 键盘配置 + 其它设置（covers: S2.4.8-9）
- [ ] T9 逐页截图自评（浅/深）+ 对比度与性能核查 + 修边（covers: S2.5, S2.6, S4）

## [S4] Acceptance
- [ ] A1 启动立即显示 splash；主窗出现时 UI 已渲染（截图验证，无白窗期）；前端异常时 15s 兜底仍能进主界面。
- [ ] A2 `npm test` 全绿（≥2091 基线）；`npm run build:web` 通过；`cargo check`（clang-cl）通过。
- [ ] A3 九个视图 + 弹窗浅/深两主题截图自评通过；正文对比度达标。
- [ ] A4 prefers-reduced-motion 下 splash 动画与过渡降级。
- [ ] A5 各页交互冒烟（导航切换、保存、弹窗开合）零功能回归。
