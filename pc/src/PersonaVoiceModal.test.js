/**
 * [Input] PersonaVoiceModal source and shared stylesheet.
 * [Output] Static coverage for the 人设与声音 modal: persona fields with templates, a per-appearance
 *          TTS provider select with provider-aware voice pickers (Doubao catalog, DashScope presets,
 *          DeepSeek presets, MiMo/custom free text), v1→v2 provider migration, validation, required (post-creation) mode,
 *          factory reset for the built-in Terrier, and the preview gate.
 * [Pos] test node in ref/src
 * [Sync] If this file changes, update `ref/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_SPEAKER_ID, TTS_PROVIDER_DOUBAO, normalizePersonaVoice } from "./lib/persona-voice.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(srcDir, "PersonaVoiceModal.jsx"), "utf8");
const css = readFileSync(join(srcDir, "styles.css"), "utf8");

test("modal edits persona fields and applies templates", () => {
  for (const key of ["display_name", "intro", "style", "address", "language", "forbidden", "greeting"]) {
    assert.match(source, new RegExp(`updatePersona\\("${key}"`), `expected persona field ${key}`);
  }
  assert.match(source, /PERSONA_TEMPLATES\.map/);
  assert.match(source, /applyTemplate\(template\)/);
});

test("voice section keeps the Doubao catalog with cloned speaker override, speed and volume", () => {
  assert.match(source, /豆包 Seed TTS 2\.0/);
  assert.match(source, /DOUBAO_SPEAKERS/);
  assert.match(source, /updateVoice\("clone_speaker_id"/);
  assert.match(source, /updateVoice\("speed"/);
  assert.match(source, /updateVoice\("volume"/);
});

test("voice section gains a 合成服务商 select with provider-aware voice pickers", () => {
  assert.match(source, /TTS_VOICE_PROVIDERS\.map/);
  assert.match(source, /changeVoiceProvider\(event\.target\.value\)/);
  assert.match(source, /跟随全局/);
  assert.match(source, /voiceSectionSubtitle/);
  assert.match(source, /voiceOptionsFor\(form\.voice\.provider/);
  assert.match(source, /resolvedTtsProviderId === "dashscope"/, "dashscope keeps the free-text voice id");
  assert.match(source, /providerVoiceOptions\.length > 0/, "any provider with preset voices gets the picker");
  assert.match(source, /填写服务商的音色 ID 或描述/, "mimo/custom get free-text voice input");
  assert.match(source, /\(voices\[0\] \|\| ""\)/, "switching to a preset provider defaults an empty speaker");
  assert.match(source, /isDoubaoVoice \?[\s\S]*?复刻音色 ID/, "clone input stays in the Doubao branch only");
});

test("preview gate follows the persona-level provider override", () => {
  assert.match(source, /overridesGlobalProvider/, "override gate variable present");
  assert.match(source, /previewAvailable = overridesGlobalProvider \|\| previewReady/,
    "an explicit different provider is allowed to attempt preview with a backend error");
});

test("v1 persona-voice documents migrate the forced doubao provider to follow-global", () => {
  const record = normalizePersonaVoice(
    {
      persona: { display_name: "小黑", style: "沉稳" },
      voice: { provider: TTS_PROVIDER_DOUBAO, speaker: DEFAULT_SPEAKER_ID, speed: 1, volume: 1 },
    },
    { name: "小黑" },
  );
  assert.equal(record.voice.provider, "");
  assert.equal(record.voice.speaker, DEFAULT_SPEAKER_ID);
});

test("required mode blocks closing until saved and validation gates the save", () => {
  assert.match(source, /const closeAllowed = !required && !saving/);
  assert.match(source, /validatePersonaVoice\(form\)/);
  assert.match(source, /savePersonaVoice\(appearance\.id, form\)/);
  assert.match(source, /保存并继续/);
});

test("built-in Terrier can restore its factory persona and preview stays gated on the voice runtime", () => {
  assert.match(source, /BUILTIN_TERRIER_PERSONA_VOICE/);
  assert.match(source, /恢复出厂人设/);
  assert.match(source, /disabled=\{!previewAvailable \|\| previewing \|\| saving \|\| !volumeReady\}/);
});

test("stylesheet defines the modal grid and the card persona line", () => {
  assert.match(css, /\.persona-voice-modal__grid\s*\{/);
  assert.match(css, /\.appearance-card__persona--missing\s*\{/);
});
