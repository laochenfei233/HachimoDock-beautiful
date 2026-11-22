import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("AppUpdateCard auto-checks on mount and renders the check/download/install flow", () => {
  const card = read("AppUpdateCard.jsx");
  assert.match(card, /invoke\("app_update_check"\)/);
  assert.match(card, /invoke\("app_update_download"\)/);
  assert.match(card, /invoke\("app_update_install", \{ path: downloadedPath \}\)/);
  assert.match(card, /invoke\("open_external_url", \{ url: status\.release_url \}\)/);
  assert.match(card, /listen\("app-update-download-progress"/);
  // Web preview (no Tauri) keeps the placeholder copy instead of failing.
  assert.match(card, /window\.__TAURI_INTERNALS__/);
  assert.match(card, /暂无发布版本/);
  // Download owns exit protection and clamps progress to 0..100.
  assert.match(card, /useExitProtection\(downloading/);
  assert.match(card, /Math\.min\(100, Number\(event\?\.payload\?\.percent\)/);
  // Asset fallback (no matching asset / macOS) degrades to the release page.
  assert.match(card, /downloadInApp = updateAvailable && installable/);
  assert.match(card, /发布于 \$\{status\.published_at\.slice\(0, 10\)\}/);
});

test("ApiSettings hosts appearance and updates inside the 其他配置 card", () => {
  const source = read("ApiSettings.jsx");
  assert.match(source, /import AppUpdateCard from "\.\/AppUpdateCard\.jsx";/);
  assert.match(source, /<Card title="其他配置" subtitle="界面外观与应用更新；这些设置不涉及服务凭据。">/);
  assert.match(source, /<AppearanceCard embedded \/>\n        <AppUpdateCard active=\{active\} embedded \/>/);
  // 嵌入模式不再套一层 Card，改用小节标题。
  const card = read("AppUpdateCard.jsx");
  assert.match(card, /if \(embedded\) \{/);
  assert.match(card, /api-settings__subsection/);
});

test("startup notice defers to the 12-hour gate and per-version dismissal", () => {
  const notice = read("AppUpdateNotice.jsx");
  assert.match(notice, /shouldShowUpdateNotice\(next, readDismissedUpdateVersion\(\)\)/);
  assert.match(notice, /dismissUpdateVersion\(status\?\.latest_version \|\| ""\)/);
  assert.match(notice, /invoke\("app_update_check"\)/);
  assert.match(notice, /invoke\("app_update_download"\)/);
  assert.match(notice, /invoke\("app_update_install", \{ path: downloadedPath \}\)/);
  assert.match(notice, /status\.release_notes/);
  assert.match(notice, /发布观察期/);
  // 无 Tauri（web 预览）时不发起检查。
  assert.match(notice, /window\.__TAURI_INTERNALS__/);
  const app = read("App.jsx");
  assert.match(app, /import AppUpdateNotice from "\.\/AppUpdateNotice\.jsx";/);
  assert.match(app, /<ToastStack \/>\n        <AppUpdateNotice \/>/);
});

test("update commands are registered with the local-only capability", () => {
  const permissions = JSON.parse(
    readFileSync(new URL("../src-tauri/permissions/local-app-commands.json", import.meta.url), "utf8"),
  );
  const allow = permissions.permission[0].commands.allow;
  for (const command of ["app_update_check", "app_update_download", "app_update_install"]) {
    assert.ok(allow.includes(command), `${command} must be allow-listed`);
  }
  const lib = read("../src-tauri/src/lib.rs");
  assert.match(lib, /mod app_update;/);
  assert.match(lib, /app_update::app_update_check,/);
  assert.match(lib, /app_update::app_update_download,/);
  assert.match(lib, /app_update::app_update_install,/);
});
