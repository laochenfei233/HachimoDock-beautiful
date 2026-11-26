/**
 * [Input] One appearance record (with its normalized `personaVoice`), an optional
 *         `required` flag for the post-creation step, and the persona/voice helpers in
 *         `lib/persona-voice.js`.
 * [Output] The 人设与声音 modal: persona form (name, intro, style, address, language,
 *          forbidden, greeting) with one-tap templates, a per-appearance TTS provider select
 *          (follow global / Doubao / DashScope / MiMo / DeepSeek / custom) with provider-aware voice pickers
 *          (Doubao catalog with language groups/search or a cloned speaker id; DashScope preset
 *          voices plus free text; DeepSeek preset voices; MiMo/custom free text; speed, volume), validation, save via
 *          `savePersonaVoice`, a "restore factory persona" action for the built-in Terrier,
 *          current-key chat instructions, API navigation without discarding drafts,
 *          shared realtime volume with native persistence, and a preview button that refreshes after speech configuration changes.
 * [Pos] component node in ref/src, opened from AppearanceGallery cards and creation flows.
 * [Sync] If this file changes, update this header and `ref/src/.folder.md`.
 */

import { formatModelIssue } from "./lib/model-issue.js";
import { speechModelMessage } from "./lib/realtime-feedback.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader, Save, Volume2, WandSparkles, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useDialogFocus } from "./component-center/use-dialog-focus.js";
import { useExitProtection } from "./lib/exit-protection.js";
import { savePersonaVoice } from "./lib/appearance-store.js";
import UsageHelp from "./UsageHelp.jsx";
import { API_CONFIGURATION_UPDATED_EVENT, TTS_PROVIDER_PRESETS } from "./lib/api-configuration.js";
import {
  BUILTIN_TERRIER_PERSONA_VOICE,
  DOUBAO_SPEAKERS,
  PERSONA_LANGUAGE_OPTIONS,
  PERSONA_TEMPLATES,
  TTS_PROVIDER_DOUBAO,
  TTS_VOICE_PROVIDERS,
  VOICE_SPEED_RANGE,
  VOICE_VOLUME_RANGE,
  createDefaultPersonaVoice,
  normalizePersonaVoice,
  presetVoicesFor,
  previewTextFor,
  speakerOptionsFor,
  validatePersonaVoice,
  voiceOptionsFor,
  voiceSpecFor,
} from "./lib/persona-voice.js";

const PREVIEW_UNAVAILABLE_HINT = "请先在「API 配置」里配置语音合成 Key，再来试听。";

async function loadVoiceChatStatus() {
  try {
    return await invoke("load_voice_chat_settings");
  } catch {
    return null;
  }
}

/** 已解析服务商的展示名；volcengine 保留完整的豆包 Seed TTS 名称。 */
function resolvedProviderLabel(providerId) {
  if (providerId === "volcengine") return "豆包 Seed TTS 2.0";
  return TTS_PROVIDER_PRESETS.find((preset) => preset.id === providerId)?.label || "";
}

async function playPersonaPreview(form) {
  await invoke("persona_voice_preview", {
    input: { text: previewTextFor(form.persona), voice: voiceSpecFor(form) },
  });
}

function initialFormState(appearance) {
  const normalized = appearance?.personaVoice
    || normalizePersonaVoice(null, {
      name: appearance?.name,
      description: appearance?.description,
      isBuiltin: appearance?.type === "builtin",
    });
  return { persona: { ...normalized.persona }, voice: { ...normalized.voice } };
}

export default function PersonaVoiceModal({ appearance, required = false, onClose, onSaved, onOpenApiSettings, previewAvailable: previewAvailableProp, onPreview = playPersonaPreview }) {
  const isBuiltin = appearance?.type === "builtin";
  const [form, setForm] = useState(() => initialFormState(appearance));
  const [savedForm, setSavedForm] = useState(() => initialFormState(appearance));
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [previewReady, setPreviewReady] = useState(Boolean(previewAvailableProp));
  const [globalTtsProvider, setGlobalTtsProvider] = useState(null); // null = 全局服务商未读到
  useEffect(() => {
    if (previewAvailableProp !== undefined) {
      setPreviewReady(Boolean(previewAvailableProp));
      return undefined;
    }
    let cancelled = false;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      loadVoiceChatStatus().then((status) => {
        if (cancelled || request !== sequence) return;
        setPreviewReady(status?.ttsConfigured === true);
        setGlobalTtsProvider(typeof status?.ttsProvider === "string" && status.ttsProvider ? status.ttsProvider : null);
      });
    };
    refresh();
    window.addEventListener(API_CONFIGURATION_UPDATED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener(API_CONFIGURATION_UPDATED_EVENT, refresh); window.removeEventListener("focus", refresh); };
  }, [previewAvailableProp]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const previewOwner = useRef(null);
  const cancelPreview = useCallback(() => {
    previewOwner.current?.abort();
    previewOwner.current = null;
  }, []);
  useEffect(() => {
    setPreviewing(false);
    return cancelPreview;
  }, [appearance?.id, cancelPreview]);
  const [volumeReady, setVolumeReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    invoke("load_realtime_voice_volume").then((volume) => {
      if (!Number.isFinite(volume) || volume < VOICE_VOLUME_RANGE.min || volume > VOICE_VOLUME_RANGE.max) {
        throw new Error("全局音量读取失败，请关闭后重试");
      }
      if (!disposed) {
        setForm((current) => ({ ...current, voice: { ...current.voice, volume } }));
        setSavedForm((current) => ({ ...current, voice: { ...current.voice, volume } }));
        setVolumeReady(true);
      }
    }).catch((error) => { if (!disposed) setSaveError(formatModelIssue("storage", "本机全局音量", error)); });
    return () => { disposed = true; };
  }, []);

  const [speakerQuery, setSpeakerQuery] = useState("");
  const speakerOptions = useMemo(() => speakerOptionsFor(form.voice.speaker, speakerQuery), [form.voice.speaker, speakerQuery]);
  const speakerGroups = useMemo(() => {
    const groups = new Map();
    for (const speaker of speakerOptions) {
      const language = speaker.language || "其他";
      if (!groups.has(language)) groups.set(language, []);
      groups.get(language).push(speaker);
    }
    return [...groups];
  }, [speakerOptions]);

  // 形象级合成服务商："" 跟随全局；复刻音色输入与豆包音色目录只在豆包下显示。
  const isDoubaoVoice = !form.voice.provider || form.voice.provider === TTS_PROVIDER_DOUBAO;
  const resolvedTtsProviderId = form.voice.provider
    ? form.voice.provider.replace(/_tts$/, "")
    : (globalTtsProvider || "");
  const resolvedTtsLabel = resolvedProviderLabel(resolvedTtsProviderId);
  // 试听 gating：跟随全局（或与全局一致）时按全局凭据就绪；显式换到其他服务商时放行——
  // 缺 Key 由后端在合成时给出该服务商的明确错误提示。
  const overridesGlobalProvider = Boolean(form.voice.provider) && globalTtsProvider !== null && resolvedTtsProviderId !== globalTtsProvider;
  const previewAvailable = overridesGlobalProvider || previewReady;
  const voiceSectionSubtitle = form.voice.provider
    ? (resolvedTtsLabel || "自定义语音合成")
    : (resolvedTtsLabel ? `跟随全局 · ${resolvedTtsLabel}` : "跟随全局");
  const providerVoiceOptions = useMemo(
    () => voiceOptionsFor(form.voice.provider, form.voice.speaker),
    [form.voice.provider, form.voice.speaker],
  );
  // 只有「服务商自带预设音色」才显示下拉；voiceOptionsFor 会把当前值补进列表，不能拿长度判断。
  const presetVoiceOptions = useMemo(
    () => presetVoicesFor(resolvedTtsProviderId).map((voice) => ({ id: voice, label: voice })),
    [resolvedTtsProviderId],
  );

  const updatePersona = useCallback((key, value) => {
    setForm((current) => ({ ...current, persona: { ...current.persona, [key]: value } }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }, []);

  const updateVoice = useCallback((key, value) => {
    setForm((current) => ({ ...current, voice: { ...current.voice, [key]: value } }));
    setErrors((current) => (current.speaker ? { ...current, speaker: undefined } : current));
  }, []);

  // 切换形象级服务商：目标服务商有预设音色且不能自由填写时（DeepSeek），收敛到第一个预设音色；
  // 其他服务商保留用户当前值（dashscope 允许自由音色 id）。
  const changeVoiceProvider = useCallback((providerId) => {
    setForm((current) => {
      const preset = TTS_PROVIDER_PRESETS.find((item) => item.id === (providerId ? providerId.replace(/_tts$/, "") : ""));
      const voices = preset?.voices || [];
      const fixedVoice = providerId === "deepseek_tts";
      const speaker = providerId && providerId !== TTS_PROVIDER_DOUBAO
        && (fixedVoice ? !voices.includes(current.voice.speaker.trim()) : !current.voice.speaker.trim())
        ? (voices[0] || "")
        : current.voice.speaker;
      return { ...current, voice: { ...current.voice, provider: providerId, speaker } };
    });
    setErrors((current) => (current.speaker ? { ...current, speaker: undefined } : current));
  }, []);

  const applyTemplate = useCallback((template) => {
    setForm((current) => ({
      ...current,
      persona: {
        ...current.persona,
        style: template.style,
        address: template.address,
        forbidden: template.forbidden,
      },
    }));
  }, []);

  const restoreFactory = useCallback(() => {
    const defaults = isBuiltin
      ? { persona: { ...BUILTIN_TERRIER_PERSONA_VOICE.persona }, voice: { ...BUILTIN_TERRIER_PERSONA_VOICE.voice } }
      : createDefaultPersonaVoice({ name: appearance?.name, description: appearance?.description });
    setForm((current) => ({ ...defaults, voice: { ...defaults.voice, volume: current.voice.volume } }));
    setErrors({});
  }, [appearance?.description, appearance?.name, isBuiltin]);

  const handleSave = useCallback(async () => {
    if (saving || !volumeReady) return;
    const nextErrors = validatePersonaVoice(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    cancelPreview();
    setPreviewing(false);
    setSaveError("");
    let volumeSaved = false;
    let personaSaved = false;
    try {
      await invoke("save_realtime_voice_volume", { volume: form.voice.volume });
      volumeSaved = true;
      const saved = await savePersonaVoice(appearance.id, form);
      personaSaved = true;
      setSavedForm(form);
      await onSaved?.(saved);
    } catch (err) {
      console.error(err);
      setSaveError(`${personaSaved ? "配置已保存，但界面刷新失败，请重新打开。" : volumeSaved
        ? "全局音量已保存，但人设与音色未完成保存，请重试。" : "保存失败："}${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [appearance?.id, form, onSaved, saving, volumeReady, cancelPreview]);

  const handlePreview = useCallback(async () => {
    if (!previewAvailable || previewOwner.current || !onPreview || !volumeReady) return;
    const { tts_overrides } = validatePersonaVoice(form);
    if (tts_overrides) {
      setErrors(current => ({ ...current, tts_overrides }));
      return;
    }
    const owner = new AbortController();
    previewOwner.current = owner;
    setPreviewing(true);
    setSaveError("");
    try {
      await onPreview(form, owner.signal);
    } catch (err) {
      if (!owner.signal.aborted) setSaveError(speechModelMessage(err));
    } finally {
      if (previewOwner.current === owner) {
        previewOwner.current = null;
        setPreviewing(false);
      }
    }
  }, [form, onPreview, previewAvailable, volumeReady]);

  const closeAllowed = !required && !saving;
  useExitProtection(saving ? "人设与声音正在保存" : JSON.stringify(form) !== JSON.stringify(savedForm)
    ? "人设与声音有未保存的修改" : "");
  const requestClose = useCallback(async () => {
    if (required || saving || confirmingClose) return;
    if (JSON.stringify(form) !== JSON.stringify(savedForm)) {
      setConfirmingClose(true);
      try {
        const discard = window.__TAURI_INTERNALS__
          ? await ask("人设与声音有未保存的修改，确定放弃吗？", {
            title: "未保存的修改", kind: "warning", okLabel: "放弃修改", cancelLabel: "继续编辑",
          })
          : window.confirm("人设与声音有未保存的修改，确定放弃吗？");
        if (!discard) return;
      } catch {
        setSaveError("无法确认退出，请保存修改后再关闭。");
        return;
      } finally { setConfirmingClose(false); }
    }
    cancelPreview();
    onClose?.();
  }, [required, saving, confirmingClose, form, savedForm, onClose, cancelPreview]);
  const dialogRef = useDialogFocus(requestClose, !closeAllowed || confirmingClose);

  return (
    <div className="modal-backdrop" onClick={closeAllowed ? requestClose : undefined}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`人设与声音 · ${appearance?.name || "宠物"}`} tabIndex={-1} className="modal-card modal-card--wide persona-voice-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">人设与声音 · {appearance?.name}</h3>
            <div className="modal-subtitle">
              {required
                ? "先为新形象设置人设与声音，让它在「实时对话」中按你喜欢的方式聊天。"
                : "设置它的名字、性格和声音，让它在「实时对话」中按你喜欢的方式聊天。"}
            </div>
          </div>
          {!required && (
            <button className="icon-btn" type="button" onClick={requestClose} disabled={saving || confirmingClose} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">
          <UsageHelp onOpenApiSettings={onOpenApiSettings} />
          {!previewAvailable && onOpenApiSettings && <button type="button" className="btn-ghost btn-sm" onClick={onOpenApiSettings}>配置语音服务</button>}
          <div className="persona-voice-modal__grid">
            <section className="persona-voice-modal__column">
              <div className="persona-voice-modal__section-head">
                <strong>人设</strong>
                <div className="persona-voice-modal__templates" aria-label="人设模板">
                  {PERSONA_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => applyTemplate(template)}
                      disabled={saving}
                    >
                      <WandSparkles size={12} /> {template.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="ui-field">
                <span className="ui-field__label">名字</span>
                <input
                  className="field-input"
                  value={form.persona.display_name}
                  onChange={(event) => updatePersona("display_name", event.target.value)}
                  placeholder="它怎么称呼自己"
                  disabled={saving}
                />
                {errors.display_name && <span className="ui-field__error">{errors.display_name}</span>}
              </label>
              <label className="ui-field">
                <span className="ui-field__label">一句话自我介绍</span>
                <textarea
                  className="field-input"
                  rows={2}
                  value={form.persona.intro}
                  onChange={(event) => updatePersona("intro", event.target.value)}
                  placeholder="它是谁、住在哪、最喜欢做什么"
                  disabled={saving}
                />
                {errors.intro && <span className="ui-field__error">{errors.intro}</span>}
              </label>
              <label className="ui-field">
                <span className="ui-field__label">性格与说话风格</span>
                <textarea
                  className="field-input"
                  rows={3}
                  value={form.persona.style}
                  onChange={(event) => updatePersona("style", event.target.value)}
                  placeholder="语气、口头禅、被夸/被冷落时的反应"
                  disabled={saving}
                />
                {errors.style && <span className="ui-field__error">{errors.style}</span>}
              </label>
              <div className="persona-voice-modal__row">
                <label className="ui-field">
                  <span className="ui-field__label">怎么称呼用户</span>
                  <input
                    className="field-input"
                    value={form.persona.address}
                    onChange={(event) => updatePersona("address", event.target.value)}
                    placeholder="例如：叫用户「主人」"
                    disabled={saving}
                  />
                </label>
                <label className="ui-field">
                  <span className="ui-field__label">语言</span>
                  <select
                    className="field-input"
                    value={form.persona.language}
                    onChange={(event) => updatePersona("language", event.target.value)}
                    disabled={saving}
                  >
                    {PERSONA_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="ui-field">
                <span className="ui-field__label">禁止事项</span>
                <input
                  className="field-input"
                  value={form.persona.forbidden}
                  onChange={(event) => updatePersona("forbidden", event.target.value)}
                  placeholder="用分号隔开"
                  disabled={saving}
                />
              </label>
              <label className="ui-field">
                <span className="ui-field__label">开场白</span>
                <input
                  className="field-input"
                  value={form.persona.greeting}
                  onChange={(event) => updatePersona("greeting", event.target.value)}
                  placeholder="进入实时对话时它先说的一句话"
                  disabled={saving}
                />
              </label>
            </section>

            <section className="persona-voice-modal__column">
              <div className="persona-voice-modal__section-head">
                <strong>声音</strong>
                <span className="muted small">{voiceSectionSubtitle}</span>
              </div>
              <label className="ui-field">
                <span className="ui-field__label">合成服务商</span>
                <select
                  className="field-input"
                  value={form.voice.provider}
                  onChange={(event) => changeVoiceProvider(event.target.value)}
                  disabled={saving}
                >
                  {TTS_VOICE_PROVIDERS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <span className="muted small">{isDoubaoVoice ? "豆包支持完整音色目录与复刻音色。" : "复刻音色仅豆包支持；此服务商下将忽略复刻字段。"}</span>
              </label>
              {isDoubaoVoice ? (
                <>
                  <label className="ui-field">
                    <span className="ui-field__label">搜索音色 · 共 {DOUBAO_SPEAKERS.length} 种</span>
                    <input className="field-input" type="search" value={speakerQuery}
                      onChange={(event) => setSpeakerQuery(event.target.value)}
                      placeholder="搜索名称、语言或音色 ID" disabled={saving} />
                  </label>
                  <label className="ui-field">
                    <span className="ui-field__label">音色</span>
                    <select
                      className="field-input"
                      value={form.voice.speaker}
                      onChange={(event) => updateVoice("speaker", event.target.value)}
                      disabled={saving}
                    >
                      {speakerGroups.map(([language, speakers]) => (
                        <optgroup key={language} label={language}>
                          {speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {speakerQuery.trim() && speakerOptions.every((speaker) => speaker.language === "当前音色") && (
                      <span className="muted small">未找到匹配音色，已保留当前选择。</span>
                    )}
                    {errors.speaker && <span className="ui-field__error">{errors.speaker}</span>}
                  </label>
                  <label className="ui-field">
                    <span className="ui-field__label">复刻音色 ID（可选，填了优先）</span>
                    <input
                      className="field-input"
                      value={form.voice.clone_speaker_id}
                      onChange={(event) => updateVoice("clone_speaker_id", event.target.value)}
                      placeholder="火山控制台声音复刻页申请所得，形如 S_xxxx"
                      disabled={saving}
                    />
                  </label>
                </>
              ) : presetVoiceOptions.length > 0 ? (
                <label className="ui-field">
                  <span className="ui-field__label">音色</span>
                  <select
                    className="field-input"
                    value={form.voice.speaker}
                    onChange={(event) => updateVoice("speaker", event.target.value)}
                    disabled={saving}
                  >
                    {!form.voice.speaker && <option value="">未选择</option>}
                    {(resolvedTtsProviderId === "dashscope" ? providerVoiceOptions : presetVoiceOptions).map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  {resolvedTtsProviderId === "dashscope" && (
                    <input
                      className="field-input"
                      value={form.voice.speaker}
                      onChange={(event) => updateVoice("speaker", event.target.value)}
                      placeholder="也可直接填写服务商的音色 ID"
                      disabled={saving}
                    />
                  )}
                  {errors.speaker && <span className="ui-field__error">{errors.speaker}</span>}
                </label>
              ) : (
                <label className="ui-field">
                  <span className="ui-field__label">音色</span>
                  <input
                    className="field-input"
                    value={form.voice.speaker}
                    onChange={(event) => updateVoice("speaker", event.target.value)}
                    placeholder="填写服务商的音色 ID 或描述"
                    disabled={saving}
                  />
                  {errors.speaker && <span className="ui-field__error">{errors.speaker}</span>}
                </label>
              )}
              <div className="persona-voice-modal__row">
                <label className="ui-field">
                  <span className="ui-field__label">搜索音色 · 共 {DOUBAO_SPEAKERS.length} 种</span>
                  <input className="field-input" type="search" value={speakerQuery}
                    onChange={(event) => setSpeakerQuery(event.target.value)}
                    placeholder="搜索名称、语言或音色 ID" disabled={saving} />
                </label>
                <label className="ui-field">
                  <span className="ui-field__label">音色</span>
                  <select
                    className="field-input"
                    value={form.voice.speaker}
                    onChange={(event) => updateVoice("speaker", event.target.value)}
                    disabled={saving}
                  >
                    {speakerGroups.map(([language, speakers]) => (
                      <optgroup key={language} label={language}>
                        {speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  {speakerQuery.trim() && speakerOptions.every((speaker) => speaker.language === "当前音色") && (
                    <span className="muted small">未找到匹配音色，已保留当前选择。</span>
                  )}
                  {errors.speaker && <span className="ui-field__error">{errors.speaker}</span>}
                </label>
                <label className="ui-field">
                  <span className="ui-field__label">复刻音色 ID（可选，填了优先）</span>
                  <input
                    className="field-input"
                    value={form.voice.clone_speaker_id}
                    onChange={(event) => updateVoice("clone_speaker_id", event.target.value)}
                    placeholder="火山控制台声音复刻页申请所得，形如 S_xxxx"
                    disabled={saving}
                  />
                </label>
              </>}
              {errors.tts_overrides && <span className="ui-field__error">{errors.tts_overrides}</span>}
              <div className="persona-voice-modal__row">
                <label className="ui-field">
                  <span className="ui-field__label">语速 <em className="muted">{Number(form.voice.speed).toFixed(2)}</em></span>
                  <input
                    className="persona-voice-modal__range"
                    type="range"
                    min={VOICE_SPEED_RANGE.min}
                    max={VOICE_SPEED_RANGE.max}
                    step={VOICE_SPEED_RANGE.step}
                    value={form.voice.speed}
                    onChange={(event) => updateVoice("speed", Number(event.target.value))}
                    disabled={saving}
                  />
                </label>}
                <label className="ui-field">
                  <span className="ui-field__label">全局音量 <em className="muted">{volumeReady ? Number(form.voice.volume).toFixed(2) : "读取中"}</em></span>
                  <input
                    className="persona-voice-modal__range"
                    type="range"
                    min={VOICE_VOLUME_RANGE.min}
                    max={VOICE_VOLUME_RANGE.max}
                    step={VOICE_VOLUME_RANGE.step}
                    value={form.voice.volume}
                    onChange={(event) => updateVoice("volume", Number(event.target.value))}
                    disabled={saving || !volumeReady}
                  />
                  <span className="muted">所有形象共用。保存后用于实时对话，不影响提示音和组件音效。</span>
                </label>
              </div>
              <div className="persona-voice-modal__preview">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handlePreview}
                  disabled={!previewAvailable || previewing || saving || !volumeReady}
                  title={previewAvailable ? "用当前人设和音色生成一句问候并播放" : previewHint}
                >
                  {previewing ? <Loader size={14} className="spin" /> : <Volume2 size={14} />} 试听
                </button>
                {previewing && <button type="button" className="btn-ghost btn-sm"
                  onClick={() => { cancelPreview(); setPreviewing(false); }}>停止试听</button>}
                <span className="muted small">
                  {previewAvailable ? "点击试听听听效果。外语音色建议使用对应语言的开场白。" : previewHint}
                </span>
              </div>
            </section>
          </div>

          {saveError && (
            <div className="message-banner message-banner--error">
              <AlertCircle size={14} /> {saveError}
            </div>
          )}
        </div>
        <div className="modal-footer persona-voice-modal__footer">
          <button type="button" className="btn-ghost btn-sm" onClick={restoreFactory} disabled={saving}>
            {isBuiltin ? "恢复出厂人设" : "恢复默认"}
          </button>
          <div className="persona-voice-modal__footer-actions">
            {!required && (
              <button type="button" className="btn-ghost" onClick={requestClose} disabled={saving || confirmingClose}>
                取消
              </button>
            )}
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || !volumeReady}>
              {saving ? <Loader size={14} className="spin" /> : <Save size={14} />} {required ? "保存并继续" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
