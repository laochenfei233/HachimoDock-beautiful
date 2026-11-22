/**
 * [Input] app_update_check status (latest_version/published_at/update_available)
 *         and the per-version dismissal recorded in localStorage.
 * [Output] Pure notice policy: a release is announced only after it has been
 *          published for 12 hours, and only once per version.
 * [Pos] shared helper in pc/src/lib, used by the startup notice and its tests.
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

export const UPDATE_NOTICE_DELAY_MS = 12 * 60 * 60 * 1000;
const DISMISS_KEY = "pet-manager.update-notice-dismissed";

/** 发布满 12 小时后才提示：给发布留存缓冲时间，也避免刚发版就被打扰。 */
export function isUpdateNoticeDue(status, now = Date.now()) {
  if (status?.update_available !== true) return false;
  const published = Date.parse(status.published_at || "");
  if (!Number.isFinite(published)) return false;
  return now - published >= UPDATE_NOTICE_DELAY_MS;
}

export function readDismissedUpdateVersion() {
  try {
    return localStorage.getItem(DISMISS_KEY) || "";
  } catch {
    return "";
  }
}

export function dismissUpdateVersion(version) {
  try {
    localStorage.setItem(DISMISS_KEY, String(version || ""));
  } catch {}
}

export function shouldShowUpdateNotice(status, dismissedVersion = "", now = Date.now()) {
  const latest = status?.latest_version || "";
  return Boolean(latest)
    && latest !== dismissedVersion
    && isUpdateNoticeDue(status, now);
}
