/**
 * [Input] Shared avatar provider configs including persisted video parameters, native Volcengine ASR credential commands, per-provider ASR/TTS voice-chat status, the persisted appearance preference, and optional return navigation.
 * [Output] Independent LLM/ASR/TTS reads, honest credential-save errors and retained navigation drafts; speech credentials are scoped per provider (Doubao keeps the keyring path), saved ASR changes are broadcast with save vs. test results distinguished, an appearance group switches light/dark/auto theme in place, MiMo exposes pay-as-you-go and China Token Plan connections, and video-generation providers switch through one segmented control with per-provider drafts retained.
 * [Pos] top-level page node in pc/src
 * [Sync] If this file changes, update this header and `pc/src/.folder.md`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import AppUpdateCard from "./AppUpdateCard.jsx";
import PageShell from "./shell/PageShell.jsx";
import Card from "./shell/Card.jsx";

import LlmNetworkSettings from "./LlmNetworkSettings.jsx";
import GenerationDiagnostics from "./GenerationDiagnostics.jsx";
import TextModelSelect from "./TextModelSelect.jsx";
import KlingVideoSettings from "./KlingVideoSettings.jsx";
import { KLING_KEY_URL } from "./lib/avatar-pipeline/kling-models.js";
import ImageModelSelect from "./ImageModelSelect.jsx";
import { VideoModelSelect } from "./VideoGenerationSettings.jsx";
import { useUsageHelp } from "./shell/DeviceContext.jsx";
import UsageHelp from "./UsageHelp.jsx";
import { useExitProtection } from "./lib/exit-protection.js";
import {
  getThemeState,
  setThemePreference,
  subscribeTheme,
} from "./lib/theme.js";
import {
  VIDEO_PROVIDERS,
  loadProviderConfig,
  saveProviderConfig,
} from "./lib/avatar-pipeline/provider-config.js";
import {
  LLM_PRESETS,
  MIMO_CONNECTIONS,
  mimoConnection,
  DEFAULT_LLM_PROVIDER,
  ASR_PROVIDER_PRESETS,
  TTS_PROVIDER_PRESETS,
  describeLlmPreset,
  selectLlmProvider,
  changeLlmEndpoint,
  selectAsrProvider,
  changeAsrEndpoint,
  selectTtsProvider,
  changeTtsEndpoint,
  speechCredentialScope,
  emitApiConfigurationUpdated,
  providerCredentialsConfigured,
} from "./lib/api-configuration.js";

function loadVideoConfigs() {
  return Object.fromEntries(
    VIDEO_PROVIDERS.map((provider) => [provider.id, loadProviderConfig(provider.id)]),
  );
}
function persistedProviderConfig(config) {
  return {
    apiKey: config.apiKey || "",
    baseUrl: config.baseUrl || "",
    model: config.model || "",
    thinkingModel: config.thinkingModel || "",
    imageModel: (config.imageModel || "").trim(),
    fastGeneration: config.fastGeneration !== false,
    videoParameters: config.videoParameters || {},
    advanced: config.advanced || {},
  };
}

function resultToneClass(tone) {
  return tone ? ` is-${tone}` : "";
}

const THEME_OPTIONS = [
  { id: "auto", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];

function AppearanceCard({ embedded = false }) {
  const [preference, setPreference] = useState(() => getThemeState().preference);
  useEffect(() => subscribeTheme((state) => setPreference(state.preference)), []);
  const subtitle = "界面主题立即生效；「跟随系统」随系统深浅色自动切换。";
  const body = (
    <>
      <div className="api-settings__segments" role="radiogroup" aria-label="外观主题">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={preference === option.id}
            className={"api-settings__segment" + (preference === option.id ? " is-active" : "")}
            onClick={() => setThemePreference(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted small">深色模式下界面与组件预览同步变暗；图片和设备屏幕内容保持原样。</p>
    </>
  );
  if (embedded) {
    return (
      <section className="api-settings__subsection" aria-label="外观">
        <header className="api-settings__subsection-head">
          <div>
            <h3 className="api-settings__subsection-title">外观</h3>
            <p className="muted small">{subtitle}</p>
          </div>
        </header>
        {body}
      </section>
    );
  }
  return <Card title="外观" subtitle={subtitle}>{body}</Card>;
}

export default function ApiSettings({ onBack, configReadError = "", active = true }) {
  const usageHelp = useUsageHelp();
  const [showSecrets, setShowSecrets] = useState(false);
  // 形象生成服务商分段切换：草稿按 provider 存在 videoConfigs 里，切换不丢。
  const [activeVideoProvider, setActiveVideoProvider] = useState(VIDEO_PROVIDERS[0]?.id || "volcengine");
  const [videoConfigs, setVideoConfigs] = useState(loadVideoConfigs);
  const [savedVideoConfigs, setSavedVideoConfigs] = useState(() => videoConfigs);
  const [providerResults, setProviderResults] = useState({});
  const [providerPending, setProviderPending] = useState({});
  const [savedLlm, setSavedLlm] = useState(null);
  const [savedSpeech, setSavedSpeech] = useState(null);
  // 语音识别/合成：豆包保持 keyring 路径；其他服务商凭据按 scope 隔离（后端只返回当前服务商掩码，
  // 前端在 asr/ttsApiKeyMasks 里记录最近见过的掩码，切换服务商时据此恢复，复刻 LLM 卡的 mask/restore 模式）。
  const [speech, setSpeech] = useState({
    loading: true,
    asrPending: false,
    asrProvider: "volcengine",
    asrModel: ASR_PROVIDER_PRESETS[0].model,
    asrBaseUrl: "",
    asrCustomBaseUrl: "",
    asrApiKey: "",
    asrApiKeyMasked: "",
    asrApiKeyMasks: {},
    asrConfigured: false,
    asrTone: "muted",
    asrMessage: "正在读取语音识别配置…",
    ttsPending: false,
    ttsProvider: "volcengine",
    ttsModel: TTS_PROVIDER_PRESETS[0].model,
    ttsBaseUrl: "",
    ttsCustomBaseUrl: "",
    ttsVoice: "",
    ttsApiKey: "",
    ttsApiKeyMasked: "",
    ttsApiKeyMasks: {},
    ttsConfigured: false,
    ttsResourceId: "",
    ttsTone: "muted",
    ttsMessage: "正在读取语音合成配置…",
  });
  // 实时对话：服务预填默认模型并允许修改；豆包 Seed TTS 2.0 复用识别 Key。
  const [voiceChat, setVoiceChat] = useState({
    loading: true,
    llmPending: false,
    llmConfigured: false,
    llmProvider: DEFAULT_LLM_PROVIDER,
    llmBaseUrl: "",
    llmModel: LLM_PRESETS.find(preset => preset.id === DEFAULT_LLM_PROVIDER).model,
    llmWebSearch: true,
    llmSearchMode: "auto",
    llmSearchApiKey: "",
    llmSearchConfigured: false,
    llmApiKey: "",
    llmApiKeyMasked: "",
    llmApiKeyMasks: {},
    llmCustomBaseUrl: "",
    llmTone: "muted",
    llmMessage: "正在读取对话大模型配置…",
  });
  const [weather, setWeather] = useState({
    loading: true, pending: false, qwKey: "", cyToken: "", qwHost: "", status: null, result: null,
  });
  const mimo = mimoConnection(voiceChat.llmProvider);
  const llmDraft = JSON.stringify([voiceChat.llmProvider, voiceChat.llmBaseUrl, voiceChat.llmModel,
    voiceChat.llmWebSearch, voiceChat.llmApiKey, voiceChat.llmSearchMode, voiceChat.llmSearchApiKey]);
  useEffect(() => { if (!voiceChat.loading && savedLlm === null) setSavedLlm(llmDraft); }, [voiceChat.loading, savedLlm, llmDraft]);
  const speechDraft = JSON.stringify([speech.asrProvider, speech.asrBaseUrl, speech.asrModel, speech.asrApiKey,
    speech.ttsProvider, speech.ttsBaseUrl, speech.ttsModel, speech.ttsVoice, speech.ttsApiKey]);
  useEffect(() => { if (!speech.loading && savedSpeech === null) setSavedSpeech(speechDraft); }, [speech.loading, savedSpeech, speechDraft]);
  const dirty = JSON.stringify(videoConfigs) !== JSON.stringify(savedVideoConfigs)
    || !!speech.asrApiKey || !!speech.ttsApiKey
    || (savedLlm !== null && savedLlm !== llmDraft) || (savedSpeech !== null && savedSpeech !== speechDraft);
  const saving = voiceChat.llmPending || speech.asrPending || speech.ttsPending
    || Object.values(providerPending).some(Boolean);
  useExitProtection(saving ? "API 配置正在保存或测试" : dirty ? "API 配置有未保存的修改" : "");

  const applyVoiceChatStatus = (status, patch = {}) => {
    setVoiceChat((current) => ({
      ...current,
      ...patch,
      loading: false,
      llmConfigured: status?.llmConfigured === true,
      llmWebSearch: status?.llmWebSearch !== false,
      llmSearchMode: status?.llmSearchMode || "auto",
      llmSearchConfigured: status?.llmSearchConfigured === true,
      llmProvider: status?.llmProvider || current.llmProvider,
      llmBaseUrl: status?.llmBaseUrl || "",
      llmModel: status?.llmModel || "",
      llmApiKeyMasked: status?.llmApiKeyMasked || "",
      llmApiKeyMasks: status?.llmApiKeyMasks || {},
      llmCustomBaseUrl: status?.llmCustomBaseUrl || "",
    }));
  };

  // 语音状态统一落位：记录各 scope 最近见过的掩码；豆包识别文案让位给 keyring 读取结果。
  const applySpeechStatus = (status, patch = {}) => {
    const asrMasked = status?.asrApiKeyMasked || "";
    const ttsMasked = status?.ttsApiKeyMasked || "";
    setSpeech((current) => {
      const asrProvider = status?.asrProvider || current.asrProvider;
      const ttsProvider = status?.ttsProvider || current.ttsProvider;
      const deviceCopyReady = current.asrMessage !== "正在读取语音识别配置…";
      const asrLabel = ASR_PROVIDER_PRESETS.find((preset) => preset.id === asrProvider)?.label || "该服务商";
      const asrCopy = asrProvider === "volcengine" && deviceCopyReady ? {}
        : {
          asrTone: status?.asrConfigured ? "success" : "muted",
          asrMessage: asrProvider === "volcengine"
            ? (status?.asrConfigured ? "豆包语音识别已配置" : "尚未配置豆包语音识别 API Key")
            : (status?.asrConfigured ? `${asrLabel}语音识别已配置` : "此服务尚未配置 API Key，请填写后保存"),
        };
      return {
        ...current,
        loading: false,
        asrProvider,
        asrModel: status?.asrModel || "",
        asrBaseUrl: status?.asrBaseUrl || "",
        asrCustomBaseUrl: asrProvider === "custom" ? (status?.asrBaseUrl || "") : current.asrCustomBaseUrl,
        asrApiKeyMasked: asrMasked,
        asrApiKeyMasks: { ...current.asrApiKeyMasks, [speechCredentialScope(asrProvider, status?.asrBaseUrl)]: asrMasked },
        asrConfigured: status?.asrConfigured === true,
        ...asrCopy,
        ttsProvider,
        ttsModel: status?.ttsModel || "",
        ttsBaseUrl: status?.ttsBaseUrl || "",
        ttsCustomBaseUrl: ttsProvider === "custom" ? (status?.ttsBaseUrl || "") : current.ttsCustomBaseUrl,
        ttsVoice: status?.ttsVoice || "",
        ttsApiKeyMasked: ttsMasked,
        ttsApiKeyMasks: { ...current.ttsApiKeyMasks, [speechCredentialScope(ttsProvider, status?.ttsBaseUrl)]: ttsMasked },
        ttsConfigured: status?.ttsConfigured === true,
        ttsResourceId: status?.ttsResourceId || current.ttsResourceId,
        ttsTone: status?.ttsConfigured ? "success" : "muted",
        ttsMessage: status?.ttsConfigured ? "语音合成已配置" : "选一家服务商，填入 API Key 即可",
        ...patch,
      };
    });
  };

  const saveLlm = async () => {
    setVoiceChat((current) => ({ ...current, llmPending: true, llmTone: "muted", llmMessage: "正在保存对话大模型配置…" }));
    try {
      const custom = voiceChat.llmProvider === "custom";
      const status = await invoke("save_voice_chat_settings", {
        input: {
          llmProvider: voiceChat.llmProvider,
          llmWebSearch: voiceChat.llmWebSearch,
          llmSearchMode: voiceChat.llmSearchMode,
          llmSearchApiKey: voiceChat.llmSearchApiKey.trim() || null,
          llmBaseUrl: custom ? voiceChat.llmBaseUrl : null,
          llmModel: voiceChat.llmModel.trim(),
          llmApiKey: voiceChat.llmApiKey.trim() || null,
        },
      });
      emitApiConfigurationUpdated({ providerId: "voice-chat-llm", configured: status?.llmConfigured === true });
      applyVoiceChatStatus(status, {
        llmPending: false,
        llmApiKey: "",
        llmSearchApiKey: "",
        llmTone: status?.llmConfigured ? "success" : "warning",
        llmMessage: status?.llmConfigured ? "配置已保存，开始聊天时将使用所选模型。" : "已保存，但还没有 API Key",
      });
      setSavedLlm(null);
    } catch (error) {
      setVoiceChat((current) => ({ ...current, llmPending: false, llmTone: "error", llmMessage: `保存失败：${error}` }));
    }
  };

  const clearSearchKey = async () => {
    setVoiceChat(current => ({ ...current, llmPending: true }));
    try {
      await invoke("clear_voice_chat_secret", { which: "search" });
      setVoiceChat(current => ({ ...current, llmPending: false, llmSearchConfigured: false,
        llmSearchApiKey: "", llmTone: "success", llmMessage: "已删除独立搜索 Key。" }));
    } catch (error) {
      setVoiceChat(current => ({ ...current, llmPending: false, llmTone: "error",
        llmMessage: `删除搜索 Key 失败：${error}` }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    invoke("load_voice_chat_settings")
      .then((status) => {
        if (!cancelled) {
          applyVoiceChatStatus(status, {
            llmTone: status?.llmConfigured ? "success" : "muted",
            llmMessage: status?.llmConfigured ? "对话大模型已配置" : "选一家大模型，填入 API Key 即可",
          });
          applySpeechStatus(status);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setVoiceChat((current) => ({ ...current, loading: false,
            llmTone: "error", llmMessage: `读取对话模型配置失败：${error}` }));
          setSpeech((current) => ({ ...current, loading: false,
            asrTone: "error", asrMessage: `读取语音识别配置失败：${error}`,
            ttsTone: "error", ttsMessage: `读取语音合成配置失败：${error}` }));
        }
      });
    // Independent services: a failed LLM read must not suppress the ASR read.
    // 豆包（keyring）读取结果只在识别服务商为 volcengine 时呈现。
    invoke("load_device_asr_settings")
      .then((status) => {
        if (cancelled) return;
        setSpeech((current) => current.asrProvider !== "volcengine"
          ? { ...current, loading: false }
          : {
            ...current,
            loading: false,
            asrConfigured: status?.configured === true,
            asrTone: status?.configured ? "success" : "muted",
            asrMessage: status?.message || "尚未配置火山引擎语音识别 API Key",
          });
      })
      .catch((error) => {
        if (cancelled) return;
        setSpeech((current) => current.asrProvider !== "volcengine"
          ? { ...current, loading: false }
          : {
            ...current,
            loading: false,
            asrTone: "error",
            asrMessage: `读取语音识别配置失败：${error}`,
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke("weather_key_status")
      .then((status) => {
        if (!cancelled) setWeather((current) => ({ ...current, loading: false, status }));
      })
      .catch((error) => {
        if (!cancelled) setWeather((current) => ({
          ...current, loading: false,
          result: { tone: "error", message: `读取天气配置失败：${error}` },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveWeatherKeys = async () => {
    if (weather.pending || weather.loading) return;
    setWeather((current) => ({ ...current, pending: true, result: null }));
    try {
      const status = await invoke("save_weather_key", {
        provider: "qweather", value: weather.qwKey, qweatherHost: weather.qwHost,
      });
      const finalStatus = weather.cyToken
        ? await invoke("save_weather_key", { provider: "caiyun", value: weather.cyToken })
        : status;
      setWeather((current) => ({
        ...current, pending: false, qwKey: "", cyToken: "", status: finalStatus,
        result: { tone: "success", message: "天气配置已保存。" },
      }));
    } catch (error) {
      setWeather((current) => ({
        ...current, pending: false,
        result: { tone: "error", message: `保存天气配置失败：${error}` },
      }));
    }
  };

  const clearWeatherKey = async (provider) => {
    if (weather.pending || weather.loading) return;
    setWeather((current) => ({ ...current, pending: true, result: null }));
    try {
      const status = await invoke("clear_weather_key", { provider });
      setWeather((current) => ({
        ...current, pending: false, status,
        ...(provider === "qweather" ? { qwKey: "" } : { cyToken: "" }),
        result: { tone: "success", message: "已清除该天气凭据。" },
      }));
    } catch (error) {
      setWeather((current) => ({
        ...current, pending: false,
        result: { tone: "error", message: `清除失败：${error}` },
      }));
    }
  };

  const configuredProviderCount = useMemo(
    () => VIDEO_PROVIDERS.filter((provider) =>
      providerCredentialsConfigured(provider.id, savedVideoConfigs[provider.id]),
    ).length,
    [savedVideoConfigs],
  );
  const configuredCount = configuredProviderCount + (speech.asrConfigured ? 1 : 0)
    + (speech.ttsConfigured ? 1 : 0) + (voiceChat.llmConfigured ? 1 : 0);

  const updateProvider = (providerId, patch) => {
    setVideoConfigs((current) => ({
      ...current,
      [providerId]: {
        ...current[providerId],
        ...patch,
      },
    }));
    setProviderResults((current) => ({ ...current, [providerId]: null }));
  };

  const saveProvider = async (providerId) => {
    if (providerPending[providerId]) return;
    const config = videoConfigs[providerId];
    if (!providerCredentialsConfigured(providerId, config)) {
      setProviderResults((current) => ({
        ...current,
        [providerId]: {
          tone: "warning",
          message: "请填写 API Key。",
        },
      }));
      return;
    }
    if (providerId === "custom") {
      try {
        new URL(config.baseUrl);
      } catch {
        setProviderResults((current) => ({
          ...current,
          [providerId]: { tone: "error", message: "请填写完整且有效的 Base URL。" },
        }));
        return;
      }
    }
    setProviderPending(current => ({ ...current, [providerId]: true }));
    try {
      await saveProviderConfig(providerId, persistedProviderConfig(config));
    } catch (error) {
      setProviderResults((current) => ({ ...current,
        [providerId]: { tone: "error", message: error.message || "配置未保存，请重试。" },
      }));
      return;
    } finally {
      setProviderPending(current => ({ ...current, [providerId]: false }));
    }
    const savedConfig = { ...config, needsKlingApiKey: false };
    setVideoConfigs(current => current[providerId] === config ? { ...current, [providerId]: savedConfig } : current);
    setSavedVideoConfigs(current => ({ ...current, [providerId]: savedConfig }));
    setProviderResults((current) => ({
      ...current,
      [providerId]: { tone: "success", message: "已保存到当前客户端。" },
    }));
    emitApiConfigurationUpdated({ providerId });
  };

  const saveAndTestAsr = async () => {
    if (!speech.asrConfigured && !speech.asrApiKey.trim()) {
      setSpeech((current) => ({
        ...current,
        asrTone: "warning",
        asrMessage: "请填写火山引擎语音识别 API Key。",
      }));
      return;
    }
    let saved = null;
    setSpeech((current) => ({
      ...current,
      asrPending: true,
      asrTone: "muted",
      asrMessage: "正在保存并测试语音识别服务…",
    }));
    try {
      saved = await invoke("save_device_asr_settings", {
        input: {
          apiKey: speech.asrApiKey.trim() || null,
        },
      });
      if (isCustom) {
        await invoke("save_voice_chat_settings", {
          input: {
            ttsProvider: "openai",
            ttsBaseUrl: speechCustom.baseUrl.trim(),
            ttsModel: speechCustom.ttsModel.trim() || null,
            ttsVoice: speechCustom.ttsVoice.trim() || null,
          },
        });
      } else {
        await invoke("save_voice_chat_settings", { input: { ttsProvider: "volcengine" } });
      }
      emitApiConfigurationUpdated({
        providerId: "volcengine-asr",
        configured: saved?.configured === true,
      });
      const probe = await invoke("test_device_asr_settings");
      setSpeech((current) => ({
        ...current,
        asrPending: false,
        asrApiKey: "",
        asrConfigured: saved?.configured === true,
        asrTone: "success",
        asrMessage: `Key 已保存，语音识别测试通过（${probe?.latencyMs ?? 0} ms）。可到「人设与声音」试听，检查语音合成是否可用。`,
      }));
    } catch (error) {
      setSpeech((current) => ({
        ...current,
        asrPending: false,
        asrApiKey: "",
        asrConfigured: saved?.configured === true || current.asrConfigured,
        asrTone: "error",
        asrMessage: `${saved ? "共享 Key 已保存，但识别测试失败" : "保存失败"}：${error}`,
      }));
    }
  };

  // 非豆包识别服务商：走 save_voice_chat_settings，凭据按 asr_provider 的 scope 入库。
  const saveSpeechAsr = async () => {
    if (speech.asrProvider === "volcengine") return saveAndTestAsr();
    if (!speech.asrConfigured && !speech.asrApiKey.trim()) {
      setSpeech((current) => ({ ...current, asrTone: "warning", asrMessage: "请填写 API Key。" }));
      return;
    }
    setSpeech((current) => ({ ...current, asrPending: true, asrTone: "muted", asrMessage: "正在保存语音识别配置…" }));
    try {
      const status = await invoke("save_voice_chat_settings", {
        input: {
          asrProvider: speech.asrProvider,
          asrModel: speech.asrModel.trim(),
          asrBaseUrl: speech.asrProvider === "custom" ? speech.asrBaseUrl.trim() : null,
          asrApiKey: speech.asrApiKey.trim() || null,
        },
      });
      emitApiConfigurationUpdated({ providerId: "voice-asr", configured: status?.asrConfigured === true });
      applySpeechStatus(status, {
        asrPending: false,
        asrApiKey: "",
        asrTone: status?.asrConfigured ? "success" : "warning",
        asrMessage: status?.asrConfigured ? "配置已保存，开始语音输入时将使用所选服务商。" : "已保存，但还没有 API Key",
      });
      setSavedSpeech(null);
    } catch (error) {
      setSpeech((current) => ({ ...current, asrPending: false, asrTone: "error", asrMessage: `保存失败：${error}` }));
    }
  };

  // 非豆包合成服务商：同一服务商识别/合成共用一把 Key。
  const saveSpeechTts = async () => {
    if (speech.ttsProvider === "volcengine") return;
    if (!speech.ttsConfigured && !speech.ttsApiKey.trim()) {
      setSpeech((current) => ({ ...current, ttsTone: "warning", ttsMessage: "请填写 API Key。" }));
      return;
    }
    setSpeech((current) => ({ ...current, ttsPending: true, ttsTone: "muted", ttsMessage: "正在保存语音合成配置…" }));
    try {
      const status = await invoke("save_voice_chat_settings", {
        input: {
          ttsProvider: speech.ttsProvider,
          ttsModel: speech.ttsModel.trim(),
          ttsVoice: speech.ttsVoice.trim(),
          ttsBaseUrl: speech.ttsProvider === "custom" ? speech.ttsBaseUrl.trim() : null,
          ttsSpeechKey: speech.ttsApiKey.trim() || null,
        },
      });
      emitApiConfigurationUpdated({ providerId: "voice-tts", configured: status?.ttsConfigured === true });
      applySpeechStatus(status, {
        ttsPending: false,
        ttsApiKey: "",
        ttsTone: status?.ttsConfigured ? "success" : "warning",
        ttsMessage: status?.ttsConfigured
          ? `已保存 ${status?.ttsApiKeyMasked}；同一服务商识别/合成共用一把 Key。`
          : "已保存，但还没有 API Key",
      });
      setSavedSpeech(null);
    } catch (error) {
      setSpeech((current) => ({ ...current, ttsPending: false, ttsTone: "error", ttsMessage: `保存失败：${error}` }));
    }
  };

  // 服务商预设了音色列表就用下拉框（通义千问 / DeepSeek），否则自由填写。
  const ttsVoiceChoices = TTS_PROVIDER_PRESETS.find((preset) => preset.id === speech.ttsProvider)?.voices || [];

  return (
    <div className="api-settings-page">
    <PageShell
      title="模型配置"
      subtitle="配置语音、对话和形象生成服务"
      actions={(
        <div className="api-settings__page-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setShowSecrets((current) => !current)}
          >
            {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
            {showSecrets ? "隐藏输入" : "显示输入"}
          </button>
          {onBack && (
            <button type="button" className="btn-ghost btn-sm" onClick={onBack}>
              <ArrowLeft size={14} />
              返回
            </button>
          )}
        </div>
      )}
    >
      {dirty && <p role="status" className="api-settings__draft">有未保存的修改。切换页面会保留草稿；关闭客户端前请保存。</p>}
      <section className="api-settings__overview" aria-label="API 配置概览">
        <div className="api-settings__overview-icon" aria-hidden="true">
          <ShieldCheck size={22} />
        </div>
        <div className="api-settings__overview-copy">
          <strong>{configReadError ? "已有配置暂时无法读取（不是配置丢失）" : `${configuredCount} / ${VIDEO_PROVIDERS.length + 3} 项凭据已配置`}</strong>
          <span>按需配置即可：给 Agent 语音输入只需语音识别；和宠物聊天还需语音合成与对话大模型；生成形象需配置形象生成服务。</span>
        </div>
        <div className="api-settings__storage-note">
          <KeyRound size={14} aria-hidden="true" />
          API Key 请勿分享给他人
        </div>
      </section>

      <Card
        title="语音识别"
        subtitle={(
          <>
            让设备听懂你说的话。
            {speech.asrProvider === "volcengine" && (
              <a
                className="api-settings__credential-link"
                href="https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh"
                target="_blank"
                rel="noreferrer"
              >
                Key 获取方式
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </>
        )}
        actions={(
          <span className={`api-settings__status${speech.asrConfigured ? " is-success" : ""}`}>
            {speech.loading ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {speech.loading ? "读取中" : speech.asrConfigured ? "已配置" : "未配置"}
          </span>
        )}
      >
        <div className="api-settings__segments" role="radiogroup" aria-label="语音识别服务商">
          {ASR_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={speech.asrProvider === preset.id}
              className={"api-settings__segment" + (speech.asrProvider === preset.id ? " is-active" : "")}
              onClick={() => setSpeech((current) => selectAsrProvider(current, preset.id))}
              disabled={speech.asrPending || speech.loading}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {speech.asrProvider === "volcengine" ? (
          <div className="api-settings__form api-settings__form--speech">
            <label className="ui-field" htmlFor="api-settings-asr-key">
              <span className="ui-field__label">API Key（识别与合成共用）</span>
              <input
                id="api-settings-asr-key"
                className="ui-control api-settings__secret-input"
                type={showSecrets ? "text" : "password"}
                autoComplete="new-password"
                value={speech.asrApiKey}
                onChange={(event) => setSpeech((current) => ({ ...current, asrApiKey: event.target.value }))}
                placeholder={speech.asrConfigured ? "已安全保存；留空可直接复测" : "输入火山引擎豆包语音 API Key"}
                disabled={speech.asrPending || speech.loading}
              />
            </label>
            <div className="api-settings__save-row">
              <button
                type="button"
                className="btn-primary btn-sm api-settings__save"
                onClick={saveAndTestAsr}
                disabled={speech.asrPending || speech.loading}
              >
                {speech.asrPending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                保存并测试
              </button>
            </div>
          </div>
        ) : (
          <div className="api-settings__form api-settings__form--asr">
            {speech.asrProvider === "custom" && (
              <label className="ui-field" htmlFor="api-settings-asr-url">
                <span className="ui-field__label">接口地址（OpenAI 兼容）</span>
                <input
                  id="api-settings-asr-url"
                  className="ui-control"
                  value={speech.asrBaseUrl}
                  onChange={(event) => setSpeech((current) => changeAsrEndpoint(current, event.target.value))}
                  placeholder="https://your-endpoint/v1"
                  disabled={speech.asrPending || speech.loading}
                />
              </label>
            )}
            {speech.asrProvider !== "deepseek" && (
              <label className="ui-field" htmlFor="api-settings-asr-model">
                <span className="ui-field__label">模型名称</span>
                <input
                  id="api-settings-asr-model"
                  className="ui-control"
                  value={speech.asrModel}
                  onChange={(event) => setSpeech((current) => ({ ...current, asrModel: event.target.value }))}
                  placeholder={ASR_PROVIDER_PRESETS.find((preset) => preset.id === speech.asrProvider)?.model || "填写服务商的识别模型"}
                  disabled={speech.asrPending || speech.loading}
                />
                <span className="muted small">
                  {speech.asrProvider === "dashscope"
                    ? "二选一：qwen3-asr-flash 走 HTTP 一次性识别（说完出全文）；paraformer-realtime-v2 走 WebSocket 流式（边说边出字幕）。"
                    : "已按服务商填入默认模型，可改为账号已开通的模型。"}
                </span>
              </label>
            )}
            <label className="ui-field" htmlFor="api-settings-asr-speech-key">
              <span className="ui-field__label">API Key</span>
              <input
                id="api-settings-asr-speech-key"
                className="ui-control api-settings__secret-input"
                type={showSecrets ? "text" : "password"}
                autoComplete="new-password"
                value={speech.asrApiKey}
                onChange={(event) => setSpeech((current) => ({ ...current, asrApiKey: event.target.value }))}
                placeholder={speech.asrApiKeyMasked ? `已保存 ${speech.asrApiKeyMasked}；留空保持不变` : "粘贴这家服务商的 API Key"}
                disabled={speech.asrPending || speech.loading}
              />
            </label>
            <div className="api-settings__save-row">
              <button
                type="button"
                className="btn-primary btn-sm api-settings__save"
                onClick={saveSpeechAsr}
                disabled={speech.asrPending || speech.loading}
              >
                {speech.asrPending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                保存
              </button>
            </div>
          </div>
        )}
        <div className={`api-settings__result${resultToneClass(speech.asrTone)}`} role="status">
          {speech.asrTone === "error" || speech.asrTone === "warning"
            ? <AlertCircle size={13} />
            : <CheckCircle2 size={13} />}
          {speech.asrMessage}
        </div>
        <div className="usage-help">
          <p><strong>语音输入：</strong>{usageHelp.voice} {usageHelp.confirm}</p>
          <p><strong>实时对话：</strong>{usageHelp.chat} 还需配置下方「语音合成」和「对话大模型」。</p>
          {usageHelp.pending && <p className="usage-help__notice">按键配置有修改，请先同步到设备。</p>}
          <details><summary>使用前需要什么</summary><p>请保持设备连接电脑，并让 Pet Manager 持续运行。默认使用豆包 ASR 2.0 和 TTS 2.0；更换服务商后，每个服务商需分别配置 API Key。</p></details>
        </div>
      </Card>

      <Card
        title="语音合成"
        subtitle="让宠物开口回应。同一服务商的识别与合成共用一个 API Key。"
        actions={(
          <span className={`api-settings__status${speech.ttsConfigured ? " is-success" : ""}`}>
            {speech.loading ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {speech.loading ? "读取中" : speech.ttsConfigured ? "已配置" : "未配置"}
          </span>
        )}
      >
        <div className="api-settings__segments" role="radiogroup" aria-label="语音合成服务商">
          {TTS_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={speech.ttsProvider === preset.id}
              className={"api-settings__segment" + (speech.ttsProvider === preset.id ? " is-active" : "")}
              onClick={() => setSpeech((current) => selectTtsProvider(current, preset.id))}
              disabled={speech.ttsPending || speech.loading}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {speech.ttsProvider === "volcengine" ? (
          <div className="api-settings__preset-summary muted small">
            豆包语音合成与识别共用一把 Key；资源编号 {speech.ttsResourceId || "seed-tts-2.0"}。音色跟随「人设与声音」里的形象配置。
          </div>
        ) : (
          <div className="api-settings__form api-settings__form--asr">
            {speech.ttsProvider === "custom" && (
              <label className="ui-field" htmlFor="api-settings-tts-url">
                <span className="ui-field__label">接口地址（OpenAI 兼容）</span>
                <input
                  id="api-settings-tts-url"
                  className="ui-control"
                  value={speech.ttsBaseUrl}
                  onChange={(event) => setSpeech((current) => changeTtsEndpoint(current, event.target.value))}
                  placeholder="https://your-endpoint/v1"
                  disabled={speech.ttsPending || speech.loading}
                />
              </label>
            )}
            {speech.ttsProvider !== "deepseek" && (
              <label className="ui-field" htmlFor="api-settings-tts-model">
                <span className="ui-field__label">模型名称</span>
                <input
                  id="api-settings-tts-model"
                  className="ui-control"
                  value={speech.ttsModel}
                  onChange={(event) => setSpeech((current) => ({ ...current, ttsModel: event.target.value }))}
                  placeholder={TTS_PROVIDER_PRESETS.find((preset) => preset.id === speech.ttsProvider)?.model || "填写服务商的合成模型"}
                  disabled={speech.ttsPending || speech.loading}
                />
                <span className="muted small">已按服务商填入默认模型，可改为账号已开通的模型。</span>
              </label>
            )}
            <label className="ui-field" htmlFor="api-settings-tts-voice">
              <span className="ui-field__label">默认音色</span>
              {ttsVoiceChoices.length > 0 ? (
                <>
                  <select
                    id="api-settings-tts-voice"
                    className="ui-control"
                    value={ttsVoiceChoices.includes(speech.ttsVoice) ? speech.ttsVoice : "__custom__"}
                    onChange={(event) => setSpeech((current) => ({
                      ...current,
                      ttsVoice: event.target.value === "__custom__" ? "" : event.target.value,
                    }))}
                    disabled={speech.ttsPending || speech.loading}
                  >
                    {ttsVoiceChoices.map((voice) => (
                      <option key={voice} value={voice}>{voice}</option>
                    ))}
                    {speech.ttsProvider === "dashscope" && <option value="__custom__">自定义…</option>}
                  </select>
                  {speech.ttsProvider === "dashscope" && !ttsVoiceChoices.includes(speech.ttsVoice) && (
                    <input
                      id="api-settings-tts-voice-custom"
                      className="ui-control"
                      value={speech.ttsVoice}
                      onChange={(event) => setSpeech((current) => ({ ...current, ttsVoice: event.target.value }))}
                      placeholder="填写服务商的音色 ID"
                      disabled={speech.ttsPending || speech.loading}
                    />
                  )}
                </>
              ) : (
                <input
                  id="api-settings-tts-voice"
                  className="ui-control"
                  value={speech.ttsVoice}
                  onChange={(event) => setSpeech((current) => ({ ...current, ttsVoice: event.target.value }))}
                  placeholder="填写服务商的音色 ID"
                  disabled={speech.ttsPending || speech.loading}
                />
              )}
              <span className="muted small">形象未单独选择音色时使用；豆包音色始终跟随形象配置。</span>
            </label>
            <label className="ui-field" htmlFor="api-settings-tts-key">
              <span className="ui-field__label">API Key</span>
              <input
                id="api-settings-tts-key"
                className="ui-control api-settings__secret-input"
                type={showSecrets ? "text" : "password"}
                autoComplete="new-password"
                value={speech.ttsApiKey}
                onChange={(event) => setSpeech((current) => ({ ...current, ttsApiKey: event.target.value }))}
                placeholder={speech.ttsApiKeyMasked ? `已保存 ${speech.ttsApiKeyMasked}；留空保持不变` : "粘贴这家服务商的 API Key"}
                disabled={speech.ttsPending || speech.loading}
              />
              <span className="muted small">同一服务商识别/合成共用一把 Key。</span>
            </label>
            <div className="api-settings__save-row">
              <button
                type="button"
                className="btn-primary btn-sm api-settings__save"
                onClick={saveSpeechTts}
                disabled={speech.ttsPending || speech.loading}
              >
                {speech.ttsPending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                保存
              </button>
            </div>
          </div>
        )}
        <div className={`api-settings__result${resultToneClass(speech.ttsTone)}`} role="status">
          {speech.ttsTone === "error" || speech.ttsTone === "warning"
            ? <AlertCircle size={13} />
            : <CheckCircle2 size={13} />}
          {speech.ttsMessage}
        </div>
      </Card>

      <Card title="对话大模型" subtitle="决定宠物在「实时对话」中如何理解和回答。选择一家服务并填写 API Key 即可。此配置用于和宠物聊天，不影响 ChatGPT、Claude 等 Agent 的语音输入。">
        <UsageHelp />
        <div className="api-settings__segments" role="radiogroup" aria-label="对话大模型">
          {[...LLM_PRESETS, { id: "custom", label: "自定义" }].map((preset) => {
            const selected = preset.id === "mimo" ? Boolean(mimo) : voiceChat.llmProvider === preset.id;
            return <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={"api-settings__segment" + (selected ? " is-active" : "")}
              onClick={() => setVoiceChat(current => selected ? current : selectLlmProvider(current, preset.id))}
              disabled={voiceChat.llmPending || voiceChat.loading}
            >
              {preset.label}
            </button>;
          })}
        </div>
        <div className="api-settings__form api-settings__form--llm">
          {mimo && (
            <label className="ui-field" htmlFor="api-settings-mimo-connection">
              <span className="ui-field__label">MiMo 接入方式</span>
              <select id="api-settings-mimo-connection" className="ui-control" value={mimo.id}
                onChange={event => setVoiceChat(current => selectLlmProvider(current, event.target.value))}
                disabled={voiceChat.llmPending || voiceChat.loading}>
                {MIMO_CONNECTIONS.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
              </select>
              <span className="muted small">接口地址 {mimo.baseUrl}</span>
            </label>
          )}
          {voiceChat.llmProvider === "custom" ? (
            <>
              <label className="ui-field" htmlFor="api-settings-llm-url">
                <span className="ui-field__label">接口地址（OpenAI 兼容）</span>
                <input
                  id="api-settings-llm-url"
                  className="ui-control"
                  value={voiceChat.llmBaseUrl}
                  onChange={(event) => setVoiceChat((current) => changeLlmEndpoint(current, event.target.value))}
                  placeholder="https://your-endpoint/v1"
                  disabled={voiceChat.llmPending || voiceChat.loading}
                />
              </label>
            </>
          ) : !mimo && (
            <div className="api-settings__preset-summary muted small">
              {describeLlmPreset(voiceChat.llmProvider, voiceChat.llmModel)}
            </div>
          )}
          <label className="ui-field" htmlFor="api-settings-llm-model">
            <span className="ui-field__label">模型名称 / 接入点 ID</span>
            <TextModelSelect value={voiceChat.llmModel}
              onChange={llmModel => setVoiceChat(current => ({ ...current, llmModel }))}
              provider={voiceChat.llmProvider} baseUrl={voiceChat.llmBaseUrl}
              apiKey={voiceChat.llmApiKey} configured={!voiceChat.loading && voiceChat.llmConfigured}
              disabled={voiceChat.llmPending || voiceChat.loading} />
            <span id="api-settings-llm-model-help" className="muted small">可填写账号已开通的模型名称或接入点 ID；留空使用默认模型。</span>
          </label>
          <label className="ui-field" htmlFor="api-settings-llm-key">
            <span className="ui-field__label">API Key</span>
            <input
              id="api-settings-llm-key"
              className="ui-control api-settings__secret-input"
              type={showSecrets ? "text" : "password"}
              autoComplete="new-password"
              value={voiceChat.llmApiKey}
              onChange={(event) => setVoiceChat((current) => ({ ...current, llmApiKey: event.target.value }))}
              placeholder={voiceChat.llmConfigured ? `已保存 ${voiceChat.llmApiKeyMasked}；留空保持不变`
                : mimo ? (mimo.id === "mimo" ? "粘贴 MiMo 按量 API Key" : "粘贴该集群的 Token Plan API Key")
                  : "粘贴这家模型的 API Key"}
              disabled={voiceChat.llmPending || voiceChat.loading}
            />
          </label>
          <label className="ui-field api-settings__search-option">
            <span><input type="checkbox" checked={voiceChat.llmWebSearch}
              disabled={voiceChat.llmPending || voiceChat.loading}
              onChange={event => setVoiceChat(current => ({ ...current, llmWebSearch: event.target.checked }))} /> 按需联网检索</span>
            <span className="muted small">询问最新消息时查询，闲聊和家居控制不查询。使用当前服务商的 Key；模型需支持原生搜索，账号可能需开通权限并产生额外费用。查询后由宠物直接回答。修改后点击保存，下次开始聊天生效。</span>
          </label>
          <div className="api-settings__save-row">
            <button
              type="button"
              className="btn-primary btn-sm api-settings__save"
              onClick={saveLlm}
              disabled={voiceChat.llmPending || voiceChat.loading}
            >
              {voiceChat.llmPending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              保存
            </button>
          </div>
        </div>
        <div className={`api-settings__result${resultToneClass(voiceChat.llmTone)}`} role="status">
          {voiceChat.llmTone === "error" || voiceChat.llmTone === "warning"
            ? <AlertCircle size={13} />
            : <CheckCircle2 size={13} />}
          {voiceChat.llmMessage}
        </div>
        <label className="ui-field api-settings__search-option">
          <span><input type="checkbox" checked={voiceChat.llmWebSearch}
            disabled={voiceChat.llmPending || voiceChat.loading}
            onChange={event => setVoiceChat(current => ({ ...current, llmWebSearch: event.target.checked }))} /> 按需联网检索</span>
          <span className="muted small">明确说「联网搜」可直接检索，闲聊和家居控制通常无需上网。检索可能单独计费。修改后点击保存，下次开始聊天生效。</span>
        </label>
        {voiceChat.llmWebSearch && <>
          <label className="ui-field">
            <span>检索来源</span>
            <select value={voiceChat.llmSearchMode}
              disabled={voiceChat.llmPending || voiceChat.loading}
              onChange={event => setVoiceChat(current => ({ ...current, llmSearchMode: event.target.value }))}>
              <option value="auto">自动 · 当前服务商</option>
              <option value="deepSeek">DeepSeek 搜索</option>
              <option value="autoWithDeepSeek">自动 · DeepSeek 备用</option>
            </select>
          </label>
          {(voiceChat.llmSearchMode !== "auto" || voiceChat.llmSearchConfigured) && <div>
            <label className="ui-field">
              <span>DeepSeek 搜索 API Key</span>
              <input type={showSecrets ? "text" : "password"} autoComplete="off" spellCheck={false}
                value={voiceChat.llmSearchApiKey}
                placeholder={voiceChat.llmSearchConfigured ? "已保存，留空继续使用" : "输入 DeepSeek 官方 API Key"}
                disabled={voiceChat.llmPending || voiceChat.loading}
                onChange={event => setVoiceChat(current => ({ ...current, llmSearchApiKey: event.target.value }))} />
              <span className="muted small">使用其他对话服务商时，请单独填写。对话已接入官方 DeepSeek 时可复用其 Key。启用备用后，当前服务商无法完成检索时会把公开关键词发送给 DeepSeek。</span>
            </label>
            {voiceChat.llmSearchConfigured && <button type="button" className="btn-ghost btn-sm"
              disabled={voiceChat.llmPending || voiceChat.loading}
              onClick={clearSearchKey}>删除独立搜索 Key</button>}
          </div>}
        </>}
        <LlmNetworkSettings />
      </Card>

      <Card title="形象生成" subtitle="新形象默认使用已配置的火山引擎，也可在生成配置中选择可灵 AI">
        <GenerationDiagnostics />
        <div className="api-settings__segments" role="radiogroup" aria-label="形象生成服务商">
          {VIDEO_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={activeVideoProvider === provider.id}
              className={"api-settings__segment" + (activeVideoProvider === provider.id ? " is-active" : "")}
              onClick={() => setActiveVideoProvider(provider.id)}
            >
              {provider.label}
            </button>
          ))}
        </div>
        <div className="api-settings__provider-grid">
          {VIDEO_PROVIDERS.filter((provider) => provider.id === activeVideoProvider).map((provider) => {
            const config = videoConfigs[provider.id];
            const configured = providerCredentialsConfigured(provider.id, savedVideoConfigs[provider.id]);
            const result = providerResults[provider.id];
            const isKling = provider.id === "kling";
            const isCustom = provider.id === "custom";
            return (
              <section className="api-settings__provider" key={provider.id}>
                <header className="api-settings__provider-head">
                  <span className="api-settings__service-mark" aria-hidden="true">
                    <Sparkles size={18} />
                  </span>
                  <span className="api-settings__provider-title">
                    <strong>{provider.label}</strong>
                    <small>
                      {provider.sub}
                      {provider.id === "volcengine" && (
                        <a
                          className="api-settings__credential-link"
                          href="https://ark.volcengine.com/model/detail?name=doubao-seedance-2-0-mini"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Key 获取方式
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      )}
                    </small>
                  </span>
                  <span className={`api-settings__status${configured ? " is-success" : ""}`}>
                    {configReadError ? "读取失败" : configured ? "已配置" : "未配置"}
                  </span>
                </header>

                <fieldset className="api-settings__provider-fields" disabled={Boolean(configReadError)} style={{border:0,margin:0,minWidth:0}}>
                  <label className="ui-field" htmlFor={`api-settings-${provider.id}-key`}>
                    <span className="ui-field__label">API Key</span>
                    <input
                      id={`api-settings-${provider.id}-key`}
                      className="ui-control api-settings__secret-input"
                      type={showSecrets ? "text" : "password"}
                      autoComplete="new-password"
                      value={config.apiKey === "hachimidock-bundled-ark-v1" ? "" : config.apiKey}
                      onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
                      placeholder={config.apiKey === "hachimidock-bundled-ark-v1" ? "内置服务已启用，可填写自己的 Key 替换" : `输入${provider.label} API Key`}
                    />
                  </label>
                  {isKling && <>
                    <a className="api-settings__credential-link" href={KLING_KEY_URL} target="_blank" rel="noreferrer">
                      在可灵国内开发者控制台获取 API Key <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    {config.needsKlingApiKey && <span className="muted small">旧版凭据需要换成新版 API Key，保存后生效。</span>}
                    <KlingVideoSettings model={config.model} value={config.videoParameters}
                      onModel={model => updateProvider(provider.id, { model })}
                      onChange={videoParameters => updateProvider(provider.id, { videoParameters })} />
                  </>}
                  {isCustom && (
                    <label className="ui-field" htmlFor="api-settings-custom-url">
                      <span className="ui-field__label">Base URL</span>
                      <input
                        id="api-settings-custom-url"
                        className="ui-control api-settings__secret-input"
                        value={config.baseUrl}
                        onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                        placeholder="https://api.example.com"
                      />
                    </label>
                  )}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">视频生成模型</span>
                    <VideoModelSelect apiKey={config.apiKey} baseUrl={config.baseUrl}
                      model={config.model} onModel={model => updateProvider(provider.id, { model })}
                      autoSelectDefault={false} />
                    <span className="muted small">用于生成形象视频；与下方提示词模型独立。修改后点击保存。</span>
                  </div>}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">图像理解 / 提示词模型</span>
                    <TextModelSelect vision label="图像理解模型" value={config.thinkingModel}
                      onChange={thinkingModel => updateProvider(provider.id, { thinkingModel })}
                      apiKey={config.apiKey} baseUrl={config.baseUrl} />
                  </div>}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">图片处理模型</span>
                    <ImageModelSelect value={config.imageModel}
                      onChange={imageModel => updateProvider(provider.id, { imageModel })}
                      apiKey={config.apiKey} baseUrl={config.baseUrl} />
                  </div>}
                </fieldset>

                <footer className="api-settings__provider-foot">
                  <span className={`api-settings__provider-result${resultToneClass(result?.tone)}`}>
                    {result?.message || (configReadError ? "原配置保留，暂不可修改" : configured ? "可用于形象生成" : "等待填写凭据")}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => saveProvider(provider.id)}
                    disabled={providerPending[provider.id] === true || Boolean(configReadError)}
                  >
                    {providerPending[provider.id] ? "保存中…" : "保存"}
                  </button>
                </footer>
              </section>
            );
          })}
        </div>
      </Card>

      <Card
        title="天气数据源"
        subtitle="桌搭子时钟等组件的天气与气温。Key 只保存在这台电脑的系统凭据库，不进入组件包。"
        actions={(
          <span className={`api-settings__status${weather.status?.qweather?.configured || weather.status?.caiyun ? " is-success" : ""}`}>
            {weather.loading ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {weather.loading
              ? "读取中"
              : weather.status?.qweather?.configured || weather.status?.caiyun ? "已配置" : "未配置"}
          </span>
        )}
      >
        <div className="api-settings__form">
          <label className="ui-field" htmlFor="api-settings-qweather-key">
            <span className="ui-field__label">和风天气 API Key</span>
            <input
              id="api-settings-qweather-key"
              type="password"
              className="ui-control api-settings__secret-input"
              value={weather.qwKey}
              onChange={(event) => setWeather((current) => ({ ...current, qwKey: event.target.value }))}
              placeholder={weather.status?.qweather?.configured ? "已配置，留空保持不变" : "在 console.qweather.com 创建"}
              disabled={weather.pending || weather.loading}
              autoComplete="off"
            />
          </label>
          <label className="ui-field" htmlFor="api-settings-qweather-host">
            <span className="ui-field__label">和风 API Host</span>
            <input
              id="api-settings-qweather-host"
              className="ui-control"
              value={weather.qwHost}
              onChange={(event) => setWeather((current) => ({ ...current, qwHost: event.target.value }))}
              placeholder={weather.status?.qweather?.host || "devapi.qweather.com（新账号使用控制台专属域名）"}
              disabled={weather.pending || weather.loading}
              autoComplete="off"
            />
          </label>
          <label className="ui-field" htmlFor="api-settings-caiyun-token">
            <span className="ui-field__label">彩云天气 Token</span>
            <input
              id="api-settings-caiyun-token"
              type="password"
              className="ui-control api-settings__secret-input"
              value={weather.cyToken}
              onChange={(event) => setWeather((current) => ({ ...current, cyToken: event.target.value }))}
              placeholder={weather.status?.caiyun ? "已配置，留空保持不变" : "在 dashboard.caiyunapp.com 申请"}
              disabled={weather.pending || weather.loading}
              autoComplete="off"
            />
          </label>
          <div className="api-settings__save-row">
            <button type="button" className="btn-primary btn-sm api-settings__save"
              onClick={saveWeatherKeys} disabled={weather.pending || weather.loading}>
              {weather.pending ? "保存中…" : "保存天气配置"}
            </button>
            {weather.status?.qweather?.configured && (
              <button type="button" className="btn-secondary btn-sm"
                onClick={() => clearWeatherKey("qweather")} disabled={weather.pending}>
                清除和风 Key
              </button>
            )}
            {weather.status?.caiyun && (
              <button type="button" className="btn-secondary btn-sm"
                onClick={() => clearWeatherKey("caiyun")} disabled={weather.pending}>
                清除彩云 Token
              </button>
            )}
          </div>
          {weather.result && (
            <div className={`api-settings__result${resultToneClass(weather.result.tone)}`} role="status">
              {weather.result.tone === "error" ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
              {weather.result.message}
            </div>
          )}
        </div>
      </Card>

      <Card title="其他配置" subtitle="界面外观与应用更新；这些设置不涉及服务凭据。">
        <AppearanceCard embedded />
        <AppUpdateCard active={active} embedded />
      </Card>
    </PageShell>
    </div>
  );
}
