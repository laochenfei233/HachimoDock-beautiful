/**
 * [Input] app_update_check status, the app-update-download-progress event, and
 *         the per-version dismissal stored by lib/app-update.js.
 * [Output] Startup notice: once a release has been published for 12 hours and
 *          the user has not dismissed that version, show a modal with the
 *          release notes and in-app download/install actions.
 * [Pos] component node in pc/src, mounted once next to ToastStack in App.jsx.
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, LoaderCircle, X } from "lucide-react";
import {
  dismissUpdateVersion,
  readDismissedUpdateVersion,
  shouldShowUpdateNotice,
} from "./lib/app-update.js";

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default function AppUpdateNotice() {
  const [status, setStatus] = useState(null);
  const [visible, setVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState("");
  const [error, setError] = useState("");

  const runCheck = useCallback(async () => {
    try {
      const next = await invoke("app_update_check");
      setStatus(next);
      if (shouldShowUpdateNotice(next, readDismissedUpdateVersion())) {
        setVisible(true);
      }
    } catch (error) {
      // 启动提示是静默能力：仓库不存在或网络不可用时什么都不显示。
      console.warn("[app-update] startup check failed", error);
    }
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    runCheck();
    // 长时间驻留时定期复查，但同一版本只会提示一次。
    const timer = setInterval(runCheck, RECHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [runCheck]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let unlisten = null;
    listen("app-update-download-progress", (event) => {
      if (cancelled || !downloading) return;
      setPercent(Math.max(0, Math.min(100, Number(event?.payload?.percent) || 0)));
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [visible, downloading]);

  const close = useCallback(() => {
    dismissUpdateVersion(status?.latest_version || "");
    setVisible(false);
  }, [status?.latest_version]);

  const openReleasePage = useCallback(() => {
    if (!status?.release_url) return;
    invoke("open_external_url", { url: status.release_url })
      .catch((error) => console.warn("[app-update] release page failed", error));
  }, [status?.release_url]);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setPercent(0);
    setError("");
    try {
      setDownloadedPath(await invoke("app_update_download"));
    } catch (error) {
      setError(String(error));
    } finally {
      setDownloading(false);
    }
  }, [downloading]);

  const install = useCallback(async () => {
    if (!downloadedPath) return;
    try {
      await invoke("app_update_install", { path: downloadedPath });
      setError("");
    } catch (error) {
      setError(String(error));
    }
  }, [downloadedPath]);

  if (!visible || !status) return null;

  const installable = status.installable === true && Boolean(status.asset_url);
  const published = status.published_at ? status.published_at.slice(0, 10) : "";

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal-card app-update-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-notice-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3 className="modal-title" id="app-update-notice-title">
              发现新版本 {status.latest_version}
            </h3>
            <div className="modal-subtitle">
              当前版本 {status.current_version}
              {published ? `；该版本发布于 ${published}，已结束 12 小时发布观察期` : ""}。
            </div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body app-update-notice__body">
          {status.release_notes ? (
            <pre className="app-update-notice__notes">{status.release_notes}</pre>
          ) : (
            <p className="muted small">该版本没有附带发布说明。</p>
          )}
          {error && (
            <div className="api-settings__result is-error" role="status">{error}</div>
          )}
        </div>
        <div className="app-update-notice__actions">
          <button className="btn-secondary" type="button" onClick={close}>
            稍后提醒
          </button>
          {status.release_url && (
            <button className="btn-ghost" type="button" onClick={openReleasePage}>
              发布页
            </button>
          )}
          {installable && (downloadedPath ? (
            <button className="btn-primary" type="button" onClick={install}>
              立即安装
            </button>
          ) : (
            <button className="btn-primary" type="button" onClick={download} disabled={downloading}>
              {downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
              {downloading ? (percent > 0 ? `下载中 ${percent}%` : "下载中…") : "下载并安装"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
