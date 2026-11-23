/**
 * [Input] ApiSettings page, App routing, feature pages, and shared stylesheet source.
 * [Output] Editable LLM/ASR/TTS model/default regression coverage plus centralized API-key ownership, per-provider speech scopes, speech key guide, saved-ASR broadcasts, routing, responsive layout, and the in-place appearance theme switch.
 * [Pos] test node in pc/src
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LLM_PRESETS,
  MIMO_CONNECTIONS,
  ASR_PROVIDER_PRESETS,
  TTS_PROVIDER_PRESETS,
  DEFAULT_LLM_PROVIDER,
  selectLlmProvider,
  changeLlmEndpoint,
  selectAsrProvider,
  changeAsrEndpoint,
  selectTtsProvider,
  changeTtsEndpoint,
  speechCredentialScope,
  describeLlmPreset,
} from "./lib/api-configuration.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const readSource = (file) => readFileSync(join(srcDir, file), "utf8");

test("API settings exposes video and prompt models independently using shared selectors", () => {
  const page = readSource("ApiSettings.jsx");
  assert.match(page, /import \{ VideoModelSelect \} from "\.\/VideoGenerationSettings.jsx"/);
  assert.match(page, /<VideoModelSelect apiKey=\{config.apiKey\} baseUrl=\{config.baseUrl\}\s+model=\{config.model\} onModel=\{model => updateProvider\(provider.id, \{ model \}\)\}/);
  assert.match(page, /thinkingModel => updateProvider\(provider.id, \{ thinkingModel \}\)/);
  assert.match(page, /model: config.model \|\| ""/);
  const selector = readSource("VideoGenerationSettings.jsx");
  assert.match(selector, /onReady\?\.\(valid\)/);
  assert.match(selector, /\[apiKey, baseUrl, revision\]/);
});

test("fresh configuration selects Doubao and search toggle is saved", () => {
  assert.equal(DEFAULT_LLM_PROVIDER,"doubao");
  const page=readSource("ApiSettings.jsx");
  assert.match(page,/llmProvider: DEFAULT_LLM_PROVIDER/);
  assert.match(page,/llmWebSearch: voiceChat.llmWebSearch/);
  assert.match(page,/llmWebSearch: status\?\.llmWebSearch !== false/);
});

test("loading API defaults cannot synthesize an unsaved edit; wizard still initializes its model", () => {
  const page=readSource("ApiSettings.jsx");
  assert.match(page, /<VideoModelSelect[\s\S]*?autoSelectDefault=\{false\}/);
  const selector=readSource("VideoGenerationSettings.jsx");
  assert.match(selector,/autoSelectDefault = true/);
  assert.match(selector,/if \(!autoSelectDefault \|\| state.loading/);
  assert.match(selector,/disabled=\{autoSelectDefault\}/);
  assert.match(page,/useExitProtection\(saving/);
  assert.match(page,/JSON.stringify\(videoConfigs\) !== JSON.stringify\(savedVideoConfigs\)/);
});

test("switching chat providers clears draft, masked key and configured state", () => {
  const providers = [...LLM_PRESETS.map(p => p.id), "custom"];
  for (const from of providers) for (const to of providers) {
    const current = { llmProvider: from, llmApiKey: "test-draft", llmApiKeyMasked: "tes…mask",
      llmConfigured: true, llmTone: "success", llmMessage: "已配置" };
    const next = selectLlmProvider(current, to);
    if (from === to) { assert.equal(next, current); continue; }
    assert.equal(next.llmApiKey, ""); assert.equal(next.llmApiKeyMasked, "");
    assert.equal(next.llmConfigured, false); assert.equal(next.llmTone, "muted");
    assert.match(next.llmMessage, /不会沿用/);
    assert.equal(current.llmApiKey, "test-draft");
  }
});

test("custom endpoint changes invalidate credentials, formatting changes do not", () => {
  const current = { llmProvider: "custom", llmBaseUrl: "https://example.invalid/v1",
    llmApiKey: "test-draft", llmApiKeyMasked: "tes…mask", llmConfigured: true };
  for (const url of ["https://another.invalid/v1", "https://example.invalid/v2", ""]) {
    const next = changeLlmEndpoint(current, url);
    assert.equal(next.llmApiKey, ""); assert.equal(next.llmApiKeyMasked, "");
    assert.equal(next.llmConfigured, false); assert.equal(next.llmBaseUrl, url);
  }
  assert.equal(changeLlmEndpoint(current, " https://example.invalid/v1/ ").llmApiKey, "test-draft");
});

test("provider and custom endpoint switches restore only their own saved masks", () => {
  const masks = { deepseek: "ds…0001", doubao: "db…0002", mimo: "mi…0003",
    "custom:https://one.invalid/v1": "one…0004", "custom:https://two.invalid/v1": "two…0005" };
  const current = { llmProvider: "deepseek", llmApiKey: "unsaved-test-draft", llmApiKeyMasks: masks,
    llmCustomBaseUrl: "https://one.invalid/v1" };
  for (const provider of ["doubao", "mimo"]) {
    const next = selectLlmProvider(current, provider);
    assert.equal(next.llmApiKey, ""); assert.equal(next.llmApiKeyMasked, masks[provider]);
    assert.equal(next.llmConfigured, true);
    assert.equal(selectLlmProvider(next, "deepseek").llmApiKeyMasked, masks.deepseek);
  }
  const custom = selectLlmProvider(current, "custom");
  assert.equal(custom.llmBaseUrl, "https://one.invalid/v1");
  assert.equal(custom.llmApiKeyMasked, "one…0004");
  assert.equal(changeLlmEndpoint(custom, "https://two.invalid/v1/").llmApiKeyMasked, "two…0005");
  assert.equal(changeLlmEndpoint(custom, "https://unknown.invalid").llmConfigured, false);
});

test("chat model names are editable for presets and provider changes use their own defaults", () => {
  assert.deepEqual(LLM_PRESETS.map(({ model }) => model), ["deepseek-flash", "doubao-seed-2-1-lite-260915", "mimo-v2.6-flash"]);
  const current = { llmProvider: "deepseek", llmModel: "my-deepseek-model", llmBaseUrl: "old", llmApiKey: "" };
  assert.equal(selectLlmProvider(current, "deepseek"), current);
  for (const preset of LLM_PRESETS.slice(1)) {
    const next = selectLlmProvider(current, preset.id);
    assert.equal(next.llmModel, preset.model);
    assert.equal(next.llmBaseUrl, preset.baseUrl);
  }
  assert.equal(selectLlmProvider(current, "custom").llmModel, "");
  assert.match(describeLlmPreset("mimo", "my-model"), /MiMo · my-model/);
  assert.match(describeLlmPreset("mimo", "  "), /mimo-v2\.6/);
  const page = readSource("ApiSettings.jsx");
  assert.match(page, /llmModel: voiceChat\.llmModel\.trim\(\)/);
  assert.doesNotMatch(page, /llmModel: custom \?/);
  assert.match(page, /\)\}\s*<label[^>]*htmlFor="api-settings-llm-model"/);
});

test("LLM scope explanation belongs to header and usage spacing is page-scoped", () => {
  const page=readSource("ApiSettings.jsx");
  assert.match(page, /title="对话大模型" subtitle="[^"]*不影响 ChatGPT、Claude 等 Agent 的语音输入/);
  assert.doesNotMatch(page, /<p[^>]*>此配置用于和宠物聊天/);
  assert.match(page, /className="api-settings-page"/);
  assert.match(readSource("styles.css"), /\.api-settings-page \.usage-help \{ margin: 0; padding-top: 10px; border-top: 1px solid var\(--line-soft\); \}/);
  assert.match(readSource("styles.css"), /\.api-settings-page \.card__subtitle \{ max-width: none;/);
});

test("API settings owns voice and generation credential inputs", () => {
  const source = readSource("ApiSettings.jsx");

  assert.match(source, /title="模型配置"/);
  assert.match(source, /load_device_asr_settings/);
  assert.match(source, /save_device_asr_settings/);
  assert.match(source, /test_device_asr_settings/);
  assert.match(source, /VIDEO_PROVIDERS\.map/);
  assert.doesNotMatch(source, /Access Key|Secret Key/);
  assert.match(source, /KlingVideoSettings/);
  assert.match(source, /href=\{KLING_KEY_URL\}/);
  assert.match(source, /type=\{showSecrets \? "text" : "password"\}/);
  assert.match(source, /saveProviderConfig/);
  assert.match(source, /emitApiConfigurationUpdated/);
  assert.doesNotMatch(source, /macOS 不使用钥匙串|仅由当前用户读取，不额外加密|无需选择模型版本|火山引擎豆包语音（识别 \+ 合成）/);
  assert.doesNotMatch(source, /2628951/);
  assert.match(source, /title="语音识别"\s+subtitle=\{\([\s\S]*?href="https:\/\/docs\.volcengine\.com\/docs\/DoubaoVoice\/APIKeyUsage\?lang=zh"[\s\S]*?Key 获取方式[\s\S]*?actions=\{/);
  assert.match(source, /title="语音合成"\s+subtitle="[^"]*识别与合成共用一个 API Key/);
  assert.match(source, /<details>[\s\S]*ASR 2\.0 和 TTS 2\.0/);
  assert.match(source, /豆包语音合成与识别共用一把 Key；资源编号 \{speech\.ttsResourceId/);
  assert.match(source, /https:\/\/ark\.volcengine\.com\/model\/detail\?name=doubao-seedance-2-0-mini/);
  assert.match(source, /provider\.id === "volcengine"/);
  assert.equal((source.match(/Key 获取方式/g) || []).length, 2);
  assert.equal((source.match(/target="_blank"/g) || []).length, 3);
  assert.equal((source.match(/rel="noreferrer"/g) || []).length, 3);
  assert.doesNotMatch(source, /devin_cloud_|Devin 云端会话/);
});

test("speech cards split recognition and synthesis with independent provider rows and counters", () => {
  const source = readSource("ApiSettings.jsx");
  assert.match(source, /aria-label="语音识别服务商"/);
  assert.match(source, /aria-label="语音合成服务商"/);
  assert.match(source, /ASR_PROVIDER_PRESETS\.map/);
  assert.match(source, /TTS_PROVIDER_PRESETS\.map/);
  assert.match(source, /selectAsrProvider\(current, preset\.id\)/);
  assert.match(source, /selectTtsProvider\(current, preset\.id\)/);
  assert.match(source, /changeAsrEndpoint\(current, event\.target\.value\)/);
  assert.match(source, /changeTtsEndpoint\(current, event\.target\.value\)/);
  assert.match(source, /speech\.asrConfigured \? 1 : 0/);
  assert.match(source, /speech\.ttsConfigured \? 1 : 0/);
  assert.match(source, /VIDEO_PROVIDERS\.length \+ 3/);
  assert.doesNotMatch(source, /title="语音识别与合成"/);
});

test("speech provider presets supply per-service defaults", () => {
  assert.deepEqual(ASR_PROVIDER_PRESETS.map(({ id, label, model }) => ({ id, label, model })), [
    { id: "volcengine", label: "豆包", model: "volc.seedasr.sauc.duration" },
    { id: "dashscope", label: "通义千问", model: "qwen3-asr-flash" },
    { id: "mimo", label: "MiMo", model: "mimo-v2.5-asr" },
    { id: "deepseek", label: "DeepSeek", model: "" },
    { id: "custom", label: "自定义", model: "" },
  ]);
  assert.deepEqual(TTS_PROVIDER_PRESETS.map(({ id, label, model, voice }) => ({ id, label, model, voice })), [
    { id: "volcengine", label: "豆包", model: "seed-tts-2.0-standard", voice: "" },
    { id: "dashscope", label: "通义千问", model: "cosyvoice-v3-flash", voice: undefined },
    { id: "mimo", label: "MiMo", model: "mimo-v2.5-tts", voice: undefined },
    { id: "deepseek", label: "DeepSeek", model: "", voice: undefined },
    { id: "custom", label: "自定义", model: "", voice: undefined },
  ]);
  assert.equal(TTS_PROVIDER_PRESETS[1].voices[0], "longxiaochun_v3");
  assert.equal(TTS_PROVIDER_PRESETS[1].voices.length, 6);
  assert.deepEqual(TTS_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek").voices, ["stella", "tide"]);
  assert.equal(speechCredentialScope("dashscope"), "dashscope");
  assert.equal(speechCredentialScope("custom", " https://one.invalid/v1/ "), "custom:https://one.invalid/v1");
  assert.equal(speechCredentialScope("custom", ""), "custom:(未填写接口地址)");
});

test("switching speech providers clears the draft key and restores their own scope masks", () => {
  const masks = { volcengine: "vb…0001", dashscope: "ds…0002", mimo: "mi…0003", deepseek: "dk…0006",
    "custom:https://one.invalid/v1": "one…0004", "custom:https://two.invalid/v1": "two…0005" };
  const asr = { asrProvider: "dashscope", asrBaseUrl: "https://dashscope.aliyuncs.com", asrModel: "old-model",
    asrApiKey: "unsaved-draft", asrApiKeyMasked: "ds…0002", asrApiKeyMasks: masks, asrConfigured: true,
    asrTone: "success", asrMessage: "已配置" };
  for (const provider of ["volcengine", "mimo", "deepseek", "custom"]) {
    const next = selectAsrProvider(asr, provider);
    if (provider === "custom") {
      assert.equal(next.asrBaseUrl, "", "custom starts from the remembered custom endpoint");
      assert.equal(next.asrApiKeyMasked, "", "empty endpoint has no saved mask");
    } else {
      assert.equal(next.asrApiKeyMasked, masks[provider]);
    }
    assert.equal(next.asrApiKey, "");
    assert.equal(next.asrConfigured, provider !== "custom");
    assert.equal(selectAsrProvider(next, "dashscope").asrApiKeyMasked, masks.dashscope);
    assert.match(next.asrMessage, /不会沿用|已读取/);
  }
  const asrCustom = { ...selectAsrProvider({ ...asr, asrCustomBaseUrl: "https://one.invalid/v1" }, "custom"),
    asrApiKey: "unsaved-draft" };
  assert.equal(asrCustom.asrBaseUrl, "https://one.invalid/v1");
  assert.equal(asrCustom.asrApiKeyMasked, "one…0004");
  assert.equal(asrCustom.asrModel, "");
  assert.equal(changeAsrEndpoint(asrCustom, "https://two.invalid/v1/").asrApiKeyMasked, "two…0005");
  assert.equal(changeAsrEndpoint(asrCustom, " https://one.invalid/v1/ ").asrApiKey, "unsaved-draft",
    "formatting-only changes keep the draft");
  assert.equal(changeAsrEndpoint(asrCustom, "https://unknown.invalid").asrConfigured, false);

  const tts = { ttsProvider: "dashscope", ttsBaseUrl: "https://dashscope.aliyuncs.com", ttsModel: "old",
    ttsVoice: "longshu_v3", ttsApiKey: "unsaved-draft", ttsApiKeyMasked: "ds…0002", ttsApiKeyMasks: masks,
    ttsConfigured: true, ttsTone: "success", ttsMessage: "已配置" };
  const toVolcengine = selectTtsProvider(tts, "volcengine");
  assert.equal(toVolcengine.ttsApiKey, "");
  assert.equal(toVolcengine.ttsApiKeyMasked, masks.volcengine);
  assert.equal(toVolcengine.ttsVoice, "", "doubao voices follow the persona, not a global default");
  const toMimo = selectTtsProvider(tts, "mimo");
  assert.equal(toMimo.ttsModel, "mimo-v2.5-tts");
  assert.equal(toMimo.ttsVoice, "", "mimo has no preset voice");
  const toDashscope = selectTtsProvider(tts, "dashscope");
  assert.equal(toDashscope, tts, "same provider keeps the draft untouched");
  const backToDashscope = selectTtsProvider(toMimo, "dashscope");
  assert.equal(backToDashscope.ttsVoice, "longxiaochun_v3", "preset providers default their first voice");
  assert.equal(backToDashscope.ttsApiKeyMasked, masks.dashscope);
  const ttsCustom = selectTtsProvider({ ...tts, ttsCustomBaseUrl: "https://one.invalid/v1" }, "custom");
  assert.equal(changeTtsEndpoint(ttsCustom, "https://two.invalid/v1/").ttsApiKeyMasked, "two…0005");
  assert.equal(changeTtsEndpoint(ttsCustom, "https://two.invalid/v1/").ttsApiKey, "");
});

test("saved ASR credentials are broadcast before the optional cloud probe", () => {
  const source = readSource("ApiSettings.jsx");
  const saveAndTest = source.match(/const saveAndTestAsr = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(saveAndTest, "expected saveAndTestAsr");

  const saveIndex = saveAndTest[0].indexOf('invoke("save_device_asr_settings"');
  const broadcastIndex = saveAndTest[0].indexOf("emitApiConfigurationUpdated({");
  const probeIndex = saveAndTest[0].indexOf('invoke("test_device_asr_settings"');
  assert.ok(saveIndex !== -1 && broadcastIndex !== -1 && probeIndex !== -1);
  assert.ok(saveIndex < broadcastIndex, "persist credentials before broadcasting");
  assert.ok(broadcastIndex < probeIndex, "broadcast must not wait for the probe");
  assert.match(saveAndTest[0], /providerId: "volcengine-asr"/);
  assert.match(saveAndTest[0], /configured: saved\?\.configured === true/);
});

test("non-volcengine speech saves go through save_voice_chat_settings and broadcast per scope", () => {
  const source = readSource("ApiSettings.jsx");
  const saveSpeech = source.match(/const saveSpeechAsr = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(saveSpeech, "expected saveSpeechAsr");
  const invokeIndex = saveSpeech[0].indexOf('invoke("save_voice_chat_settings"');
  const broadcastIndex = saveSpeech[0].indexOf('emitApiConfigurationUpdated({ providerId: "voice-asr"');
  assert.ok(invokeIndex !== -1 && broadcastIndex !== -1);
  assert.ok(invokeIndex < broadcastIndex, "persist credentials before broadcasting");
  assert.match(saveSpeech[0], /asrProvider: speech\.asrProvider/);
  assert.match(saveSpeech[0], /asrModel: speech\.asrModel\.trim\(\)/);
  assert.match(saveSpeech[0], /asrBaseUrl: speech\.asrProvider === "custom" \? speech\.asrBaseUrl\.trim\(\) : null/);
  assert.match(saveSpeech[0], /asrApiKey: speech\.asrApiKey\.trim\(\) \|\| null/);
  assert.match(saveSpeech[0], /configured: status\?\.asrConfigured === true/);

  const saveTts = source.match(/const saveSpeechTts = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(saveTts, "expected saveSpeechTts");
  assert.match(saveTts[0], /ttsProvider: speech\.ttsProvider/);
  assert.match(saveTts[0], /ttsModel: speech\.ttsModel\.trim\(\)/);
  assert.match(saveTts[0], /ttsVoice: speech\.ttsVoice\.trim\(\)/);
  assert.match(saveTts[0], /ttsBaseUrl: speech\.ttsProvider === "custom" \? speech\.ttsBaseUrl\.trim\(\) : null/);
  assert.match(saveTts[0], /ttsSpeechKey: speech\.ttsApiKey\.trim\(\) \|\| null/);
  assert.match(saveTts[0], /providerId: "voice-tts"/);
  assert.match(saveTts[0], /已保存 \$\{status\?\.ttsApiKeyMasked\}/);
});

test("app exposes API configuration as a first-level sidebar page", () => {
  const app = readSource("App.jsx");

  assert.match(app, /const ApiSettings = lazy\(\(\) => import\("\.\/ApiSettings"\)\)/);
  assert.match(app, /activeTab = view === "api"/);
  assert.match(app, /title="模型配置"/);
  assert.match(app, /view === "api"[\s\S]*<ApiSettings/);
  assert.match(app, /onOpenApiSettings/);
});

test("feature pages no longer render API-key inputs", () => {
  const wizard = readSource("CustomAvatarWizard.jsx");
  const detail = readSource("AppearanceDetail.jsx");
  const voice = readSource("dashboard/VoiceAssistantPanel.jsx");

  assert.doesNotMatch(wizard, /type="password"/);
  assert.doesNotMatch(detail, /type="password"/);
  assert.doesNotMatch(voice, /type="password"/);
  assert.match(wizard, /打开 API 配置/);
  assert.match(voice, /前往 API 配置/);
});

test("API settings uses a responsive provider grid", () => {
  const css = readSource("styles.css");

  assert.match(css, /\.api-settings__provider-grid\s*\{/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.api-settings__provider-grid/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.api-settings__form--asr/);
});

test("appearance group switches the persisted theme in place", () => {
  const source = readSource("ApiSettings.jsx");
  assert.match(source, /aria-label="外观主题"/);
  assert.match(source, /setThemePreference\(option\.id\)/);
  assert.match(source, /subscribeTheme\(\(state\) => setPreference\(state\.preference\)\)/);
  const theme = readSource("lib/theme.js");
  assert.match(theme, /THEME_STORAGE_KEY = "pet-manager\.theme-preference"/);
  assert.match(theme, /document\.documentElement\.dataset\.theme = theme/);
});

test("MiMo only lists pay-as-you-go and China Token Plan with separate credentials", () => {
  assert.deepEqual(MIMO_CONNECTIONS.map(({ id, baseUrl }) => [id, baseUrl]), [
    ["mimo", "https://api.xiaomimimo.com/v1"],
    ["mimo-token-plan-cn", "https://token-plan-cn.xiaomimimo.com/v1"],
  ]);
  const payg = { llmProvider: "mimo", llmApiKey: "draft-paying-key",
    llmApiKeyMasks: { mimo: "old-payg", "mimo-token-plan-cn": "old-token-plan" } };
  const token = selectLlmProvider(payg, "mimo-token-plan-cn");
  assert.equal(token.llmApiKey, "");
  assert.equal(token.llmApiKeyMasked, "old-token-plan");
  assert.equal(token.llmBaseUrl, MIMO_CONNECTIONS[1].baseUrl);
  assert.equal(selectLlmProvider(token, "mimo").llmApiKeyMasked, "old-payg");
});
