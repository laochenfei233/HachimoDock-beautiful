/**
 * [Input] Browser API-configuration changes plus provider/ASR/TTS status values.
 * [Output] Shared API configuration event, editable LLM/ASR/TTS defaults, provider/endpoint-specific saved key masks, fixed ASR/TTS 2.0 defaults, and readiness helpers.
 * [Pos] config helper in pc/src/lib
 * [Sync] If this file changes, update this header and `pc/src/.folder.md`.
 */

import { DEFAULT_LITE_MODEL } from "./text-models.js";
export const API_CONFIGURATION_UPDATED_EVENT = "pet-manager:api-configuration-updated";
export const DEFAULT_LLM_PROVIDER = "doubao";

/** 对话大模型默认值（与 Rust `voice_chat_settings::LLM_PRESETS` 一致），模型名可修改。 */
export const LLM_PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { id: "doubao", label: "豆包", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: DEFAULT_LITE_MODEL },
  { id: "mimo", label: "MiMo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.6-flash" },
];

export const MIMO_CONNECTIONS = [
  { ...LLM_PRESETS.find(preset => preset.id === "mimo"), label: "按量 API" },
  { id: "mimo-token-plan-cn", label: "Token Plan", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.6-flash" },
];

export function mimoConnection(providerId) {
  return MIMO_CONNECTIONS.find(connection => connection.id === providerId);
}

function llmPreset(providerId) {
  return LLM_PRESETS.find(preset => preset.id === providerId) || mimoConnection(providerId);
}

export const DEFAULT_TTS_RESOURCE_ID = "seed-tts-2.0";

function restoreLlmCredential(current) {
  const endpoint = (current.llmBaseUrl || "").trim().replace(/\/+$/, "") || "https://api.deepseek.com";
  const scope = current.llmProvider === "custom" ? `custom:${endpoint}` : current.llmProvider;
  const masked = current.llmApiKeyMasks?.[scope] || "";
  return { ...current, llmApiKey: "", llmApiKeyMasked: masked, llmConfigured: Boolean(masked),
    llmTone: "muted", llmMessage: masked ? "已读取该服务的 API Key，点击保存应用切换。"
      : "此服务尚未配置 API Key，请填写后保存；不会沿用其他服务的 Key。" };
}

export function selectLlmProvider(current, providerId) {
  if (current.llmProvider === providerId) return current;
  const preset = llmPreset(providerId);
  return restoreLlmCredential({ ...current, llmProvider: providerId,
    llmBaseUrl: preset?.baseUrl || current.llmCustomBaseUrl || "", llmModel: preset?.model || "" });
}

export function changeLlmEndpoint(current, baseUrl) {
  const normalize = (value) => (value || "").trim().replace(/\/+$/, "");
  const changed = current.llmProvider === "custom" && normalize(current.llmBaseUrl) !== normalize(baseUrl);
  const next = { ...current, llmBaseUrl: baseUrl };
  return changed ? restoreLlmCredential(next) : next;
}

export function describeLlmPreset(providerId, model) {
  const preset = llmPreset(providerId);
  if (!preset) return "自定义 OpenAI 兼容端点";
  return `${preset.label} · ${model?.trim() || preset.model} · ${preset.baseUrl}`;
}

export const ASR_RESOURCE_OPTIONS = [
  { id: "volc.seedasr.sauc.duration", label: "豆包 ASR 2.0" },
];

/** 语音识别服务商默认值（与 Rust `voice_chat_settings::SPEECH_PRESETS` 一致），模型可修改；MiMo 走 Chat Completions 短语音识别。 */
export const ASR_PROVIDER_PRESETS = [
  { id: "volcengine", label: "豆包", model: "volc.seedasr.sauc.duration" },
  { id: "dashscope", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com", model: "qwen3-asr-flash" },
  { id: "mimo", label: "MiMo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-asr" },
  // DeepSeek 语音工具接口没有模型参数（语种自动识别），模型字段留空且界面不展示。
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "" },
  { id: "custom", label: "自定义", model: "" },
];

/** 语音合成服务商默认值（与 Rust `voice_chat_settings::SPEECH_PRESETS` 一致）；音色随服务商与形象配置。 */
export const TTS_PROVIDER_PRESETS = [
  { id: "volcengine", label: "豆包", model: "seed-tts-2.0-standard", voice: "" },
  { id: "dashscope", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com", model: "cosyvoice-v3-flash",
    voices: ["longxiaochun_v3", "longshu_v3", "longanrou_v3", "longshange_v3", "longanxuan_v3", "longlaotie_v3"] },
  { id: "mimo", label: "MiMo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voices: [] },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "", voices: ["stella", "tide"] },
  { id: "custom", label: "自定义", model: "", voices: [] },
];

/** 语音凭据 scope（与 Rust `speech_scope` 一致）：custom 按端点隔离，其余按服务商。 */
export function speechCredentialScope(providerId, baseUrl = "") {
  if (providerId === "custom") {
    const url = (baseUrl || "").trim().replace(/\/+$/, "");
    return `custom:${url || "(未填写接口地址)"}`;
  }
  return (providerId || "").trim();
}

/** 切换 scope 后清空草稿 Key，并按 scope 恢复已保存的掩码（后端只返回当前服务商掩码，前端记录最近见过的）。 */
function restoreSpeechCredential(current, kind) {
  const masked = current[`${kind}ApiKeyMasks`]?.[speechCredentialScope(current[`${kind}Provider`], current[`${kind}BaseUrl`])] || "";
  return { ...current,
    [`${kind}ApiKey`]: "",
    [`${kind}ApiKeyMasked`]: masked,
    [`${kind}Configured`]: Boolean(masked),
    [`${kind}Tone`]: "muted",
    [`${kind}Message`]: masked ? "已读取该服务的 API Key，点击保存应用切换。"
      : "此服务尚未配置 API Key，请填写后保存；不会沿用其他服务的 Key。" };
}

export function selectAsrProvider(current, providerId) {
  if (current.asrProvider === providerId) return current;
  const preset = ASR_PROVIDER_PRESETS.find((item) => item.id === providerId);
  return restoreSpeechCredential({ ...current, asrProvider: providerId,
    asrModel: preset?.model || "",
    asrBaseUrl: providerId === "custom" ? (current.asrCustomBaseUrl || "") : (preset?.baseUrl || "") }, "asr");
}

export function changeAsrEndpoint(current, baseUrl) {
  const normalize = (value) => (value || "").trim().replace(/\/+$/, "");
  const changed = current.asrProvider === "custom" && normalize(current.asrBaseUrl) !== normalize(baseUrl);
  const next = { ...current, asrBaseUrl: baseUrl, asrCustomBaseUrl: baseUrl };
  return changed ? restoreSpeechCredential(next, "asr") : next;
}

export function selectTtsProvider(current, providerId) {
  if (current.ttsProvider === providerId) return current;
  const preset = TTS_PROVIDER_PRESETS.find((item) => item.id === providerId);
  return restoreSpeechCredential({ ...current, ttsProvider: providerId,
    ttsModel: preset?.model || "",
    ttsVoice: preset?.voices?.[0] || preset?.voice || "",
    ttsBaseUrl: providerId === "custom" ? (current.ttsCustomBaseUrl || "") : (preset?.baseUrl || "") }, "tts");
}

export function changeTtsEndpoint(current, baseUrl) {
  const normalize = (value) => (value || "").trim().replace(/\/+$/, "");
  const changed = current.ttsProvider === "custom" && normalize(current.ttsBaseUrl) !== normalize(baseUrl);
  const next = { ...current, ttsBaseUrl: baseUrl, ttsCustomBaseUrl: baseUrl };
  return changed ? restoreSpeechCredential(next, "tts") : next;
}

export function providerCredentialsConfigured(_providerId, config = {}) {
  return Boolean(config.apiKey?.trim());
}
export function emitApiConfigurationUpdated(detail = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_CONFIGURATION_UPDATED_EVENT, { detail }));
}
