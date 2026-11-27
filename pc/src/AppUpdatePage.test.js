/**
 * [Input] AppUpdatePage.jsx, App.jsx sidebar wiring and ApiSettings placement.
 * [Output] Static coverage: update page auto-check + download/install flow,
 *          sidebar entry below 固件升级, link rows, and the removal from the
 *          model-settings card.
 * [Pos] test node in pc/src
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

test("update page auto-checks on mount and renders the check/download/install flow", () => {
  const page = read("AppUpdatePage.jsx");
  assert.match(page, /invoke\("app_update_check"\)/);
  assert.match(page, /invoke\("app_update_download"\)/);
  assert.match(page, /invoke\("app_update_install", \{ path: downloadedPath \}\)/);
  assert.match(page, /listen\("app-update-download-progress"/);
  assert.match(page, /if \(!active \|\| !window\.__TAURI_INTERNALS__\) return;/);
  assert.match(page, /已是最新版本/);
  assert.match(page, /暂无发布版本/);
  assert.match(page, /下载并安装/);
  assert.match(page, /立即安装/);
});

test("update page lists official links and the mirrored update source", () => {
  const page = read("AppUpdatePage.jsx");
  for (const label of ["官方网站", "更新日志", "源码仓库", "意见反馈"]) {
    assert.ok(page.includes(label), label);
  }
  assert.match(page, /GitHub Releases（自动镜像回退）/);
  assert.match(page, /open_external_url/);
});

test("sidebar hosts the entry right below the firmware upgrade item", () => {
  const app = read("App.jsx");
  const firmware = app.indexOf("<FirmwareUpdateNavItem");
  const update = app.indexOf('title="应用更新"');
  assert.ok(firmware > 0 && update > firmware, "应用更新 must follow 固件升级");
  assert.ok(update - firmware < 400, "entry stays adjacent to the firmware item");
  assert.match(app, /const AppUpdatePage = lazy\(\(\) => import\("\.\/AppUpdatePage"\)\);/);
  assert.match(app, /view === "update" && <AppUpdatePage active=\{view === "update"\} \/>/);
  assert.match(app, /view === "update" \? "update"/);
});

test("model settings no longer embed the update card", () => {
  const settings = read("ApiSettings.jsx");
  assert.doesNotMatch(settings, /AppUpdateCard/);
  assert.doesNotMatch(settings, /title="其他配置"/);
  assert.match(settings, /<AppearanceCard \/>/);
});
