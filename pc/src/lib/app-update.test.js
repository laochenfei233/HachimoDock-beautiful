import test from "node:test";
import assert from "node:assert/strict";
import {
  UPDATE_NOTICE_DELAY_MS,
  dismissUpdateVersion,
  isUpdateNoticeDue,
  readDismissedUpdateVersion,
  shouldShowUpdateNotice,
} from "./app-update.js";

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  return values;
}

const status = (overrides = {}) => ({
  update_available: true,
  latest_version: "v0.1.246",
  published_at: "2026-11-21T00:00:00Z",
  ...overrides,
});

test("a fresh release is not announced until the 12-hour observation window passes", () => {
  const published = Date.parse("2026-11-21T00:00:00Z");
  assert.equal(isUpdateNoticeDue(status(), published + UPDATE_NOTICE_DELAY_MS - 1), false);
  assert.equal(isUpdateNoticeDue(status(), published + UPDATE_NOTICE_DELAY_MS), true);
  assert.equal(isUpdateNoticeDue(status(), published + 3 * UPDATE_NOTICE_DELAY_MS), true);
});

test("no notice without a confirmed update or a parseable publish time", () => {
  assert.equal(isUpdateNoticeDue(status({ update_available: false })), false);
  assert.equal(isUpdateNoticeDue(status({ published_at: "" })), false);
  assert.equal(isUpdateNoticeDue(status({ published_at: "not-a-date" })), false);
  assert.equal(isUpdateNoticeDue(null), false);
});

test("each version is announced once; a newer version is announced again", () => {
  const published = Date.parse("2026-11-21T00:00:00Z");
  const now = published + UPDATE_NOTICE_DELAY_MS;
  installStorage();
  assert.equal(shouldShowUpdateNotice(status(), "", now), true);
  dismissUpdateVersion("v0.1.246");
  assert.equal(readDismissedUpdateVersion(), "v0.1.246");
  assert.equal(shouldShowUpdateNotice(status(), readDismissedUpdateVersion(), now), false);
  assert.equal(shouldShowUpdateNotice(status({ latest_version: "v0.1.247" }), readDismissedUpdateVersion(), now), true);
});
