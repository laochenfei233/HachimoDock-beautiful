---
feature: deepseek-voice
status: delivered
updated: 2026-11-23
branch: feat/deepseek-voice
worktree: .worktrees/deepseek-voice
commits: 5747e87..bca9807
---

# DeepSeek 语音识别 / 语音合成接入（ASR + TTS）

## Report

**What was built** — 现有 ASR/TTS 多服务商体系新增 `deepseek`：Rust 侧 `deepseek_voice.rs` 实现 TTS（`POST /v1/tools/tts` 整段流式 PCM，24 kHz 重采样到 16 kHz，音色仅 stella/tide，其他 id 回落 stella）与 ASR（`POST /v1/tools/asr` multipart 单文件，无模型/语种字段，`OneShotAsr` 只出 Final）；`SPEECH_PRESETS`、`asr_engine`、`tts_engine` 与 ASR 状态标签接通，凭据按 provider scope 隔离。前端 ASR/TTS 预设、设置页（deepseek 不渲染模型输入；音色下拉来自服务商预设 `voices`）、形象级 `deepseek_tts` 与 stella/tide 音色选择全部可用。审查中发现并修复一个既有缺陷：`merge_settings` 里遗留的 `tts_provider` 覆盖会把任何非 `openai` 的 TTS 选择写回 volcengine，导致 DeepSeek（以及原本的通义千问/MiMo）语音合成选择保存后回退；删除覆盖并补回归测试后，TTS 服务商选择可正常持久化。

**Verification** — 前端（worktree）7 个相关测试文件 57/57 通过（ApiSettings 19、persona-voice 9、PersonaVoiceModal 8、realtime-chat 12、voice-credential-events 4、tts-voices 2、persona-live-update 3）；@babel/parser 解析修改后的 JSX/JS 通过；`cargo check --lib --tests` PASS。完整 `cargo test --lib`（短 `CARGO_TARGET_DIR` + 手工 SxS manifest）1510 passed / 14 failed，14 个失败均在不相关子系统（auth_provider、component_library、component_media、graphics_acceptance、usb_serial、weather_keys、lib.rs fixture 列表、mimo_voice_diagnostics 源码扫描），本次新增/更新的 5 个 Rust 测试全部通过；其中 mimo_voice_diagnostics 的失败已用基线源码核对（5747e87 的 `continue_device_voice_context_start` 同样不含断言字符串），属既有测试漂移。独立审查 3 轮：首轮 CHANGES REQUIRED（A1 持久化 CRITICAL + A5 音色选择器 MAJOR + A2/A3 测试缺口），二轮 CHANGES REQUIRED（音色 gate 用错列表导致 MiMo/custom 失去自由填写，MAJOR），三轮 APPROVE。

### Journey log

1. **既有 TTS 持久化缺陷**：`merge_settings` 在 `merge_speech_settings` 之后又把 `tts_provider` 强制写成 `openai`/`volcengine`，任何非豆包 TTS 选择保存即回退；保留该块会让 DeepSeek TTS 无法全局选择。删除该块（`merge_speech_settings` 已负责归一化与按 scope 写 Key）并加 `tts_provider_saves_persist_for_every_preset...` 回归测试，顺带修复通义千问/MiMo 的同类问题。
2. **音色选项列表不能代表「有预设音色」**：`voiceOptionsFor` 会把当前音色补进列表，用 `length > 0` 判断会让 MiMo/自定义也进入下拉、丢掉自由填写。新增 `presetVoicesFor()`（只返回预设列表）作为 gate；切换服务商时只对 DeepSeek（无自由填写）收敛到 `stella`，通义千问的自定义音色 id 保留。
3. **Windows Rust 测试 harness**：`ring` 的 C 编译需要短 `CARGO_TARGET_DIR`（如 `C:/Users/chenfei/cargo-target/hachimo-dsv`，`/Z7` 长命令行会 D8050）；`scripts/run-tests-windows.mjs` 固定扫描 `target/debug/deps`，而该构建把 lib 测试 exe 放在 `target/debug/build/<pkg>/<hash>/out/`，因此手工在同目录放 SxS manifest 后直接 `cargo test --lib`。
4. **不伪造模型名**：DeepSeek 两个接口都没有模型参数，预设 `asr_model/tts_model` 留空并在设置页对 deepseek 隐藏模型输入，避免用户填写无效字段。

## [S1] Problem

现有语音体系已支持豆包 / 通义千问 / MiMo / 自定义兼容端点，但 DeepSeek 的语音工具 API（`POST /v1/tools/asr`、`POST /v1/tools/tts`）尚未接入：用户即使持有 DeepSeek Key，也无法把语音识别或语音合成切到 DeepSeek，只能借用其他服务商。

## [S2] Design

总体：沿用 `voice-provider-expansion` 的多服务商结构，新增一个 `deepseek` provider id，不新增配置字段、不改存储格式、不动固件与 server。

### S2.1 接口事实与预设

- ASR：`POST https://api.deepseek.com/v1/tools/asr`，`multipart/form-data` 的 `file` 字段（16 位 PCM WAV 或 Ogg Opus，≤8 MiB，≤120 s），响应 `{"text": ...}`；**没有模型参数**，语种自动识别。
- TTS 整段：`POST https://api.deepseek.com/v1/tools/tts`，JSON `{text, voice_id?, format?}`，`format:"pcm"` 返回 24 kHz / 16 位 / 单声道原始 PCM；音色只有 `stella`（默认）与 `tide`。
- 预设：`id: deepseek`、`label: DeepSeek`、`base_url: https://api.deepseek.com`、`asr_model: ""`、`tts_model: ""`、`tts_voice: "stella"`（Rust 与前端两份预设保持一致）。

### S2.2 适配器（`pc/src-tauri/src/deepseek_voice.rs`）

- `DeepseekTtsClient` 实现 `TtsEngine`：POST JSON（`tts_payload()`，便于单测请求形状），`format:"pcm"`，流式读 `response.chunk()`，用既有 `openai_audio::ResampleState` / `resample_24k_to_16k` 转 16 kHz；HTTP 非 2xx 与「已开始返回但中途断开」都按失败返回。
- 音色收敛 `voice_id()`：非 `tide` 一律 `stella`（形象沿用的豆包音色 id 不会让请求 400）。
- ASR：`transcribe()` 复用 `openai_audio::upload_transcription(url, key, &[], pcm)`（本轮把上传/解析抽成该共用函数，OpenAI 兼容路径行为不变），整体仍走 `OneShotAsr`，只有 Final，无 Partial。
- `shortcut: ASR 是一次性接口，整轮只有 Final；需要边说边出字时换流式服务商。`

### S2.3 路由与配置

- `SPEECH_PRESETS` 追加 deepseek；`apply_speech_defaults` 自动填 baseUrl 与 `stella` 默认音色，凭据继续按 provider scope 存于 `speech_api_keys`，与 LLM Key 隔离。
- `asr_engine::create` 增加 `"deepseek"` 分支（`Transcriber::Deepseek`）。
- `tts_engine_with_cache_key` 增加 `"deepseek"` 分支，音色经 `effective_tts_voice` → `voice_id` 收敛，缓存键沿用 `news-pcm16-v2|provider|model|voice|speed`。
- `volcengine_asr::global_provider_label` 增加 `deepseek`，ASR 状态不再错误显示为 `volcengine`。
- 删除 `merge_settings` 中遗留的 `tts_provider` 覆盖（非 `openai` 一律写回 `volcengine`）；`merge_speech_settings` 成为唯一归一化/写入点，否则任何非豆包 TTS 选择保存后都会回退（交付前既有缺陷，一并修复）。

### S2.4 前端

- `api-configuration.js`：`ASR_PROVIDER_PRESETS` / `TTS_PROVIDER_PRESETS` 追加 DeepSeek（TTS `voices: ["stella","tide"]`，无模型）。
- `ApiSettings.jsx`：deepseek 不渲染模型输入（接口无此参数）；合成卡音色下拉改为「按当前服务商预设的 `voices`」渲染（dashscope 6 个、deepseek 2 个），其余服务商仍自由填写；「自定义…」只留给 dashscope。
- `persona-voice.js`：`TTS_VOICE_PROVIDERS` 增加 `deepseek_tts`；新增 `presetVoicesFor()` 作为「该服务商是否有预设音色」的唯一判据。
- `PersonaVoiceModal.jsx`：音色选择器 gate 改为预设音色列表（不能看 `voiceOptionsFor` 的补全结果，否则 MiMo/自定义会丢失自由填写）；切到 `deepseek_tts` 时把不属于 stella/tide 的音色收敛为 `stella`，其他服务商保留用户当前音色（dashscope 自定义 id 不丢）。

## [S3] Scope

- In scope：DeepSeek ASR/TTS 适配器、provider 预设与路由、设置页与形象声音选择、相关文档/更新日志、测试更新、TTS 服务商选择持久化修复。
- Out of scope：TTS WebSocket 流式接口（`wss://…/v1/tools/tts`）、Markdown 过滤开关、语速参数（DeepSeek 不支持）、固件、server、凭据与 LLM Key 合并、ASR 路由单测（与其他服务商一致，仅一行 match 分支）。

## Tasks

- [x] T1: 新增 `deepseek_voice.rs`（TTS 流式 PCM + 重采样、ASR multipart），复用 `openai_audio` 的上传与重采样；`cargo` 模块注册（depends: none）
- [x] T2: `voice_chat_settings` 预设与 TTS 工厂分支、`asr_engine` 路由、`volcengine_asr` 状态标签、TTS 选择持久化修复（depends: T1）
- [x] T3: 前端预设、ApiSettings 模型/音色 UI、形象级 `deepseek_tts`（depends: none）
- [x] T4: 更新测试（preset 列表、provider 切换、TTS 持久化、payload/multipart、voiceOptionsFor/presetVoicesFor）与文档/更新日志（depends: T1–T3）
- [x] T5: 验证：前端相关测试 + `cargo check --lib --tests` + 完整 `cargo test --lib`（depends: T4）
- [x] T6: 独立审查与修复（3 轮，最终 APPROVE）（depends: T5）

## [S4] Acceptance

- [x] A1: API 配置中可选择 DeepSeek 作为识别或合成服务商，凭据按 `deepseek` scope 独立保存/恢复，切换不串用；TTS 选择可持久化（`voice_chat_settings::tests::tts_provider_saves_persist_for_every_preset_instead_of_falling_back_to_doubao`、前端 provider 切换测试）。
- [x] A2: TTS 请求形状为 `{text, voice_id, format:"pcm"}`，音色非 stella/tide 时回落 stella，输出为 16 kHz 单声道 S16LE（`deepseek_voice::tts_payload_matches_the_tools_api_and_falls_back_to_stella` + 既有重采样单测）。
- [x] A3: ASR 请求为 `/v1/tools/asr` multipart 单文件、无模型字段，整轮只产生 Final（`deepseek_voice::tool_endpoints_join_the_preset_host_without_duplicating_slashes`、`openai_audio::empty_fields_produce_a_file_only_multipart_form`；路由为单行分支，由编译检查与代码审查覆盖）。
- [x] A4: 设置页 deepseek 不显示无意义的模型输入；合成音色下拉为 stella/tide（ApiSettings.test.js 源码断言 + `TTS_PROVIDER_PRESETS` 断言）。
- [x] A5: 形象「人设与声音」可选 DeepSeek 合成，音色选项为 stella/tide；MiMo/自定义自由填写与通义千问自定义音色 id 保持不变（persona-voice + PersonaVoiceModal 测试）。
- [x] A6: 存量配置与默认豆包行为不变；前端相关测试 57/57、`cargo check --lib --tests` 与新增 Rust 测试全绿，完整测试套件仅剩 14 个不相关子系统的既有环境/夹具失败。
