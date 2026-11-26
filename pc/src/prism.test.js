/**
 * [Input] Prism (prism-agent) production wiring in Rust discovery, registries,
 * permissions and the visible-composer voice path shared with DeepSeek Harness.
 * [Output] Static wiring checks: prism rides the composer adapter under its own
 * identity (no bound-history fallback) and its session switch is allow-listed.
 * [Pos] test node in pc/src
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("Rust registers prism-agent as a first-class bus, registry and composer channel", () => {
  const rust = read("../src-tauri/src/lib.rs");

  assert.match(rust, /detect_prism\(\),/);
  assert.match(rust, /KNOWN_USB_STATE_SOURCES: \[&str; 10\]/);
  assert.match(rust, /"prism-agent" \| "prism" => Some\("prism-agent"\.to_string\(\)\)/);
  assert.match(rust, /"prism-agent" => "prism-agent"\.to_string\(\)/);
  assert.match(rust, /"prism-agent" \| "prism" => "Prism"\.to_string\(\)/);
  assert.match(rust, /"prism-agent" => 24,/);

  const body = (name) => {
    const start = rust.indexOf(`fn ${name}(`);
    assert.notEqual(start, -1, `missing native contract ${name}`);
    const end = rust.indexOf("\n}", start);
    assert.notEqual(end, -1, `missing native contract boundary ${name}`);
    return rust.slice(start, end + 2);
  };
  assert.match(body("agent_uses_visible_composer"), /"prism-agent"/);
  assert.match(body("visible_composer_agent_label"), /"prism-agent"/);
  assert.match(body("agent_streams_voice_draft"), /"prism-agent"/);
  assert.match(body("should_use_current_visible_session"), /matches!\(agent_id,[^\n]*"prism-agent"/);
  assert.match(body("device_voice_bound_target_is_addressable"), /"prism-agent"/);
});

test("prism session switching is registered and allow-listed", () => {
  const rust = read("../src-tauri/src/lib.rs");
  const permissions = JSON.parse(read("../src-tauri/permissions/local-app-commands.json"));

  assert.match(rust, /fn prism_activate_session\(/);
  assert.ok(
    permissions.permission[0].commands.allow.includes("prism_activate_session"),
    "prism_activate_session missing from local-app-commands allow list",
  );
});

test("prism voice rejects bound history and rides the composer identity maps", () => {
  const rust = read("../src-tauri/src/lib.rs");
  const composer = read("../src-tauri/src/codex_composer.rs");
  const macos = read("../src-tauri/src/codex_composer_macos.rs");

  // Voice draft startup refuses bound sessions for prism like DSH/WorkBuddy.
  assert.match(rust, /"workbuddy" \| "devin" \| "deepseek-harness"(?: \| "[^"]+")*\) \{\s*Err\(/);
  // Windows identity: real Tauri binary name, verified against the NSIS layout.
  assert.match(composer, /"prism-agent" => macos::MacosAgent::PrismAgent/);
  assert.match(composer, /"prism-agent" => &\["prism-agent\.exe"\]/);
  assert.match(composer, /'prism-agent'/);
  // macOS identity: bundle id + app name + exact normalized window title.
  assert.match(macos, /MacosAgent::PrismAgent/);
  assert.match(macos, /"ai\.prism\.agent\.desktop"/);
  assert.match(macos, /&\["Prism Agent"\]/);
  assert.match(macos, /"prism agent"/);
});
