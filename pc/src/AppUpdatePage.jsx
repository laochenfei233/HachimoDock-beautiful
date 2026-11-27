/**
 * [Input] Tauri app_update_check/download/install commands, the
 *         app-update-download-progress event, and the GitHub release repo
 *         configured in src-tauri/src/app_update.rs.
 * [Output] 应用更新页：版本与检查状态、发布说明、应用内下载/安装、更新源说明，
 *          以及官方网站／更新日志／源码仓库／意见反馈入口。
 * [Pos] 页面节点 in pc/src, 侧栏「固件升级」下方的「应用更新」入口。
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight, Download, FileText, Github, Globe, LoaderCircle, MessageSquare, RefreshCw,
} from "lucide-react";
import PageShell from "./shell/PageShell.jsx";
import { useToast } from "./shell/ToastStack.jsx";
import { useExitProtection } from "./lib/exit-protection.js";
import hachimodockMark from "./assets/logo/hachimodock-mark.png";

const REPOSITORY = "https://github.com/laochenfei233/HachimoDock-beautiful";
const LINKS = [
  { icon: Globe, label: "官方网站", href: REPOSITORY },
  { icon: FileText, label: "更新日志", href: `${REPOSITORY}/releases` },
  { icon: Github, label: "源码仓库", href: REPOSITORY },
  { icon: MessageSquare, label: "意见反馈", href: `${REPOSITORY}/issues` },
];

function openExternal(url) {
  if (!url) return;
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    invoke("open_external_url", { url }).catch((error) => console.warn("[app-update] link failed", error));
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export default function AppUpdatePage({ active = true }) {
  const { push } = useToast();
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState("");
  useExitProtection(downloading ? "应用更新下载中，请等待完成后再离开此页" : "");

  const runCheck = useCallback(async ({ announce = false } = {}) => {
    setChecking(true);
    try {
      const next = await invoke("app_update_check");
      setStatus(next);
      if (announce) {
        push({
          tone: next.update_available ? "success" : "info",
          title: next.update_available ? `发现新版本 ${next.latest_version}` : "已是最新版本",
          message: next.update_available ? "可在下方下载并安装。" : `当前版本 ${next.current_version}。`,
        });
      }
    } catch (error) {
      if (announce) push({ tone: "error", title: "检查更新失败", message: String(error) });
    } finally {
      setChecking(false);
    }
  }, [push]);

  useEffect(() => {
    if (!active || !window.__TAURI_INTERNALS__) return;
    runCheck();
  }, [active, runCheck]);

  useEffect(() => {
    let cancelled = false;
    let unlisten = null;
    listen("app-update-download-progress", (event) => {
      if (cancelled || !downloading) return;
      const next = Math.max(0, Math.min(100, Number(event?.payload?.percent) || 0));
      setPercent(next);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.warn("[app-update] progress unavailable", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [downloading]);

  const startDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setPercent(0);
    try {
      const path = await invoke("app_update_download");
      setDownloadedPath(path);
      push({ tone: "success", title: "安装包下载完成", message: "点击「立即安装」并按安装器引导完成升级。" });
    } catch (error) {
      push({ tone: "error", title: "下载安装包失败", message: String(error) });
    } finally {
      setDownloading(false);
    }
  }, [downloading, push]);

  const startInstall = useCallback(async () => {
    if (!downloadedPath) return;
    try {
      await invoke("app_update_install", { path: downloadedPath });
      push({
        tone: "success",
        title: "安装程序已启动",
        message: "按安装器引导完成升级；安装期间不要关闭本应用。",
      });
    } catch (error) {
      push({ tone: "error", title: "无法启动安装", message: String(error) });
    }
  }, [downloadedPath, push]);

  const latest = status?.latest_version || "";
  const updateAvailable = status?.update_available === true;
  const hasRelease = status?.has_release === true;
  const installable = status?.installable === true;
  const downloadInApp = updateAvailable && installable && status?.asset_url;
  const currentVersion = status?.current_version || "…";
  const published = status?.published_at ? `，发布于 ${status.published_at.slice(0, 10)}` : "";

  const state = checking ? { tone: "", text: "正在检查更新…" }
    : !status ? { tone: "", text: "尚未检查更新。" }
    : !hasRelease ? { tone: "", text: "暂无发布版本（更新仓库还没有 Release）。" }
    : updateAvailable ? { tone: "success", text: downloadInApp ? `发现新版本 ${latest}${published}。` : `发现新版本 ${latest}${published}；请前往发布页下载本平台的安装包。` }
    : { tone: "", text: `已是最新版本（${latest}）${published}。` };

  return (
    <PageShell title="应用更新" subtitle="检查并安装桌面客户端的新版本；安装包来自 GitHub Releases。">
      <div className="update-panel">
        <section className="update-panel__hero" aria-label="客户端版本">
          <img className="update-panel__logo" src={hachimodockMark} alt="" />
          <div className="update-panel__identity">
            <h2>HachimoDock</h2>
            <p>桌宠管理端 · 连接桌面小屏的宠物伴侣与 Agent 状态看板</p>
            <span className="update-panel__version">v{currentVersion}</span>
            <span className={`update-panel__state${state.tone ? ` is-${state.tone}` : ""}`} role="status">
              <i aria-hidden="true" />
              {state.text}
            </span>
          </div>
          <button type="button" className="btn-secondary update-panel__check"
            onClick={() => runCheck({ announce: true })} disabled={checking || downloading}>
            {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            检查更新
          </button>
          {updateAvailable && status?.release_notes && (
            <pre className="api-settings__release-notes update-panel__notes">{status.release_notes}</pre>
          )}
          {updateAvailable && (
            <div className="update-panel__actions">
              {downloadInApp && (downloadedPath ? (
                <button type="button" className="btn-primary btn-sm" onClick={startInstall}>
                  <Download size={14} />立即安装
                </button>
              ) : (
                <button type="button" className="btn-primary btn-sm" onClick={startDownload} disabled={downloading}>
                  {downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                  {downloading ? (percent > 0 ? `下载中 ${percent}%` : "下载中…") : "下载并安装"}
                </button>
              ))}
              {status?.release_url && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => openExternal(status.release_url)}>
                  前往发布页
                </button>
              )}
            </div>
          )}
        </section>

        <section className="update-panel__source" aria-label="更新源">
          <div className="update-panel__row-head">
            <span>更新源</span>
            <strong>GitHub Releases（自动镜像回退）</strong>
          </div>
          <p>优先直连 GitHub；不可用时经 gh-proxy 镜像下载同一份安装包，并在下载后校验文件。</p>
        </section>

        <nav className="update-panel__links" aria-label="相关链接">
          {LINKS.map(({ icon: Icon, label, href }) => (
            <button key={label} type="button" className="update-panel__link" onClick={() => openExternal(href)}>
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
              <span className="update-panel__open">打开 <ChevronRight size={14} aria-hidden="true" /></span>
            </button>
          ))}
        </nav>
      </div>
    </PageShell>
  );
}
