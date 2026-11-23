---
feature: deepseek-voice
status: in-progress
updated: 2026-11-23
branch: feat/deepseek-voice
worktree: .worktrees/deepseek-voice
commits:
---

# DeepSeek 语音识别 / 语音合成接入（ASR + TTS）

## Report

## [S1] Problem

现有语音体系已支持豆包 / 通义千问 / MiMo / 自定义兼容端点，但 DeepSeek 的语音工具 API（`POST /v1/tools/asr`、`POST /v1/tools/tts`）尚未接入：用户即使持有 DeepSeek Key，也无法把语音识别或语音合成切到 DeepSeek，只能借用其他服务商。

## [S2] Design

总体：沿用 `voice-provider-expansion` 的多服务商结构，新增一个 `deepseek` provider id，不新增配置字段、不改存储格式、不动固件与 server。

### S2.1 接口事实与预设

- ASR：`POST https://api.deepseek.com/v1/tools/asr`，`multipart/form-data` 的 `file` 字段（16 位 PCM WAV 或 Ogg Opus，≤8 MiB，≤120 s），响应 `{"text": ...}`；**没有模型参数**，语种自动识别。
- TTS 整段：`POST https://api.deepseek.com/v1/tools/tts`，JSON `{text, voice_id?, format?}`，`format:"pcm"` 返回 24 kHz / 16 位 / 单声道原始 PCM；音色只有 `stella`（默认）与 `tide`。
- 预设：`id: deepseek`、`label: DeepSeek`、`base_url: https://api.deepseek.com`、`asr_model: ""`、`tts_model: ""`、`tts_voice: "stella"`（Rust 与前端两份预设保持一致）。

### S2.2 适配器（`pc/src-tauri/src/deepseek_voice.rs`）

- `DeepseekTtsClient` 实现 `TtsEngine`：POST JSON，`format:"pcm"`，流式读 `response.chunk()`，用既有 `openai_audio::ResampleState` / `resample_24k_to_16k` 转 16 kHz；HTTP 非 2xx 与「已开始返回但中途断开」都按失败返回。
- 音色收敛 `voice_id()`：非 `tide` 一律 `stella`（形象沿用的豆包音色 id 不会让请求 400）。
- ASR：`transcribe()` 复用 `openai_audio::upload_transcription(url, key, &[], pcm)`（本轮把上传/解析抽成该共用函数，OpenAI 兼容路径行为不变），整体仍走 `OneShotAsr`，只有 Final，无 Partial。
- `shortcut: ASR 是一次性接口，整轮只有 Final；需要边说边出字时换流式服务商。`

### S2.3 路由与配置

- `SPEECH_PRESETS` 追加 deepseek；`apply_speech_defaults` 自动填 baseUrl 与 `stella` 默认音色，凭据继续按 provider scope 存于 `speech_api_keys`，与 LLM Key 隔离。
- `asr_engine::create` 增加 `"deepseek"` 分支（`Transcriber::Deepseek`）。
- `tts_engine_with_cache_key` 增加 `"deepseek"` 分支，音色经 `effective_tts_voice` → `voice_id` 收敛，缓存键沿用 `news-pcm16-v2|provider|model|voice|speed`。
- `volcengine_asr::global_provider_label` 增加 `deepseek`，ASR 状态不再错误显示为 `volcengine`。

### S2.4 前端

- `api-configuration.js`：`ASR_PROVIDER_PRESETS` / `TTS_PROVIDER_PRESETS` 追加 DeepSeek（TTS `voices: ["stella","tide"]`，无模型）。
- `ApiSettings.jsx`：deepseek 不渲染模型输入（接口无此参数）；合成卡音色下拉改为「按当前服务商预设的 `voices`」渲染（dashscope 6 个、deepseek 2 个），其余服务商仍自由填写。
- `persona-voice.js`：`TTS_VOICE_PROVIDERS` 增加 `deepseek_tts`（形象级合成服务商）；`voiceOptionsFor` 自动得到 stella/tide。

## [S3] Scope

- In scope：DeepSeek ASR/TTS 适配器、provider 预设与路由、设置页与形象声音选择、相关文档/更新日志、测试更新。
- Out of scope：TTS WebSocket 流式接口（`wss://…/v1/tools/tts`）、Markdown 过滤开关、语速参数（DeepSeek 不支持）、固件、server、凭据与 LLM Key 合并。

## Tasks

- [ ] T1: 新增 `deepseek_voice.rs`（TTS 流式 PCM + 重采样、ASR multipart），复用 `openai_audio` 的上传与重采样；`cargo` 模块注册（depends: none）
- [ ] T2: `voice_chat_settings` 预设与 TTS 工厂分支、`asr_engine` 路由、`volcengine_asr` 状态标签（depends: T1）
- [ ] T3: 前端预设、ApiSettings 模型/音色 UI、形象级 `deepseek_tts`（depends: none）
- [ ] T4: 更新测试（preset 列表、provider 切换、voiceOptionsFor）与文档/更新日志（depends: T1–T3）
- [ ] T5: 验证：前端相关测试 + `cargo check`（depends: T4）
- [ ] T6: 独立审查与修复（depends: T5）

## [S4] Acceptance

- [ ] A1: API 配置中可选择 DeepSeek 作为识别或合成服务商，凭据按 `deepseek` scope 独立保存/恢复，切换不串用。
- [ ] A2: TTS 请求形状为 `{text, voice_id, format:"pcm"}`，音色非 stella/tide 时回落 stella，输出为 16 kHz 单声道 S16LE（适配器单测 + 既有重采样单测）。
- [ ] A3: ASR 请求为 `/v1/tools/asr` multipart 单文件、无模型字段，整轮只产生 Final（上传共用函数单测 + 路由单测）。
- [ ] A4: 设置页 deepseek 不显示无意义的模型输入；合成音色下拉为 stella/tide。
- [ ] A5: 形象「人设与声音」可选 DeepSeek 合成，音色选项为 stella/tide。
- [ ] A6: 存量配置与默认豆包行为不变，既有测试通过；`cargo check` 与前端相关测试全绿。
