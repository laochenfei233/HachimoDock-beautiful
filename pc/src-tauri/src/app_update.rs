//! 应用更新板块后端：查询 GitHub `laochenfei233/HachimoDock` 的最新 release，
//! 与当前版本比较，在应用内下载 Windows 安装包（镜像回退 + 进度事件）并启动安装。
//! release 仓库尚不存在（404）或网络失败时返回空态而非错误；下载写入 updates/
//! 目录的 .part 临时文件后原子改名，安装命令只接受该目录内的 .exe。

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const RELEASE_API: &str = "https://api.github.com/repos/laochenfei233/HachimoDock-beautiful/releases/latest";
const MIRROR_PREFIX: &str = "https://gh-proxy.com/";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
pub struct AppUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub release_name: String,
    pub release_notes: String,
    pub release_url: String,
    pub published_at: String,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub update_available: bool,
    /// release 存在（区别于「仓库还没有 Release」的空态，用于「前往发布页」回退）。
    pub has_release: bool,
    /// 本平台是否支持应用内下载+安装；macOS 只引导到发布页。
    pub installable: bool,
}

/// release 不可得（404/网络失败/无可用安装包资产）时的空态。
fn empty_status(current_version: &str) -> AppUpdateStatus {
    AppUpdateStatus {
        current_version: current_version.to_string(),
        latest_version: String::new(),
        release_name: String::new(),
        release_notes: String::new(),
        release_url: String::new(),
        published_at: String::new(),
        asset_name: String::new(),
        asset_url: String::new(),
        asset_size: 0,
        update_available: false,
        has_release: false,
        installable: cfg!(windows),
    }
}

/// 比较 `v?X.Y.Z(-suffix)?` 形式版本号；任一侧无法按段解析为数字时返回 None。
fn compare_versions(current: &str, latest: &str) -> Option<bool> {
    let strip = |v: &str| -> Option<Vec<u64>> {
        let core = v.trim().trim_start_matches('v').split('-').next()?;
        if core.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        for segment in core.split('.') {
            if segment.is_empty() || !segment.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            parts.push(segment.parse::<u64>().ok()?);
        }
        Some(parts)
    };
    let mut left = strip(current)?;
    let mut right = strip(latest)?;
    let width = left.len().max(right.len());
    left.resize(width, 0);
    right.resize(width, 0);
    Some(right > left)
}

#[derive(Clone, Debug)]
struct Asset {
    name: String,
    url: String,
    size: u64,
}

/// 同一发布同时提供多架构安装包：优先选架构匹配的资产，找不到再退回任意匹配项。
/// Windows 只在名称含 windows 的 *.exe 里选，macOS 只在 *.dmg 里选。
fn pick_asset(assets: &[Asset]) -> Option<Asset> {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let arch_alias = if cfg!(target_arch = "aarch64") { "aarch64" } else { "amd64" };
    let matches_arch = |name: &str| name.contains(arch) || name.contains(arch_alias);
    let candidates: Vec<Asset> = assets
        .iter()
        .filter(|asset| {
            let lower = asset.name.to_ascii_lowercase();
            if cfg!(target_os = "macos") {
                lower.ends_with(".dmg")
            } else {
                lower.contains("windows") && lower.ends_with(".exe")
            }
        })
        .cloned()
        .collect();
    candidates
        .iter()
        .find(|asset| matches_arch(&asset.name.to_ascii_lowercase()))
        .or_else(|| candidates.first())
        .cloned()
}

fn http_client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(DOWNLOAD_TIMEOUT)
        .timeout(Duration::from_secs(30))
        .user_agent("HachimoDock-desktop")
        .build()
}

/// 拉取 latest release 并选择安装包资产；仓库 404 或解析失败返回 None。
fn fetch_latest_release() -> Option<(serde_json::Value, Vec<Asset>)> {
    let response = http_client().ok()?
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .ok()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return None;
    }
    if !response.status().is_success() {
        return None;
    }
    let release: serde_json::Value = response.json().ok()?;
    let tag = release.get("tag_name")?.as_str()?.trim().to_string();
    if tag.is_empty() {
        return None;
    }
    let assets = release.get("assets")?.as_array()?.iter().filter_map(|a| {
        Some(Asset {
            name: a.get("name")?.as_str()?.trim().to_string(),
            url: a.get("browser_download_url")?.as_str()?.trim().to_string(),
            size: a.get("size")?.as_u64()?,
        })
    }).collect::<Vec<_>>();
    Some((release, assets))
}

#[tauri::command]
pub async fn app_update_check() -> AppUpdateStatus {
    // 网络检查可能阻塞到连接超时；放在阻塞线程，避免非异步命令冻结主线程。
    tauri::async_runtime::spawn_blocking(|| {
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let Some((release, assets)) = fetch_latest_release() else {
            return empty_status(&current_version);
        };
        let latest_version = release.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        let update_available = compare_versions(&current_version, &latest_version).unwrap_or(false);
        let base = AppUpdateStatus {
            current_version: current_version.clone(),
            latest_version,
            release_name: release.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            release_notes: release.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
            release_url: release.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
            published_at: release.get("published_at").and_then(|p| p.as_str()).unwrap_or("").to_string(),
            asset_name: String::new(),
            asset_url: String::new(),
            asset_size: 0,
            update_available,
            has_release: true,
            installable: cfg!(windows),
        };
        match pick_asset(&assets) {
            Some(asset) => AppUpdateStatus {
                asset_name: asset.name,
                asset_url: asset.url,
                asset_size: asset.size,
                ..base
            },
            // release 存在但没有本平台安装包：保留比较结果与 release_url，
            // 前端 downloadInApp 因 asset_url 为空而不渲染下载按钮，走「前往发布页」回退。
            None => base,
        }
    })
    .await
    .unwrap_or_else(|_| empty_status(env!("CARGO_PKG_VERSION")))
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("updates");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建更新目录：{e}"))?;
    Ok(dir)
}

/// 下载安装包到 updates/<asset-name>；先直连，失败自动走一次镜像回退。
fn download_asset(app: &AppHandle, asset: &Asset, dir: &Path) -> Result<PathBuf, String> {
    let final_path = dir.join(&asset.name);
    let part_path = dir.join(format!("{}.part", asset.name));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("无法创建下载客户端：{e}"))?;
    let mut last_error = String::new();
    for url in [asset.url.as_str(), &format!("{MIRROR_PREFIX}{}", asset.url)] {
        let response = match client.get(url).timeout(Duration::from_secs(60 * 60)).send() {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = format!("HTTP {}", response.status().as_u16());
                continue;
            }
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        let result = stream_to_file(app, response, &part_path, asset.size);
        match result {
            Ok(()) => {
                fs::rename(&part_path, &final_path)
                    .map_err(|e| format!("无法完成下载文件改名：{e}"))?;
                return Ok(final_path);
            }
            Err(error) => {
                last_error = error;
                let _ = fs::remove_file(&part_path);
            }
        }
    }
    Err(format!("下载安装包失败（直连与镜像均失败）：{last_error}"))
}

fn stream_to_file(
    app: &AppHandle,
    mut response: reqwest::blocking::Response,
    part_path: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let mut file = fs::File::create(part_path).map_err(|e| format!("无法创建下载临时文件：{e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_percent: i64 = -1;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response.read(&mut buffer).map_err(|e| format!("下载读取失败：{e}"))?;
        if read == 0 {
            break;
        }
        downloaded += read as u64;
        if expected_size > 0 && downloaded > expected_size + 1024 * 1024 {
            return Err("下载内容超过声明的安装包大小".into());
        }
        file.write_all(&buffer[..read]).map_err(|e| format!("下载写入失败：{e}"))?;
        let percent = if expected_size > 0 {
            ((downloaded.saturating_mul(100)) / expected_size).min(100) as i64
        } else {
            -1
        };
        if percent != last_percent {
            last_percent = percent;
            let _ = app.emit(
                "app-update-download-progress",
                serde_json::json!({
                    "percent": percent.max(0),
                    "downloaded": downloaded,
                    "total": expected_size,
                }),
            );
        }
    }
    file.flush().map_err(|e| format!("下载收尾失败：{e}"))?;
    if expected_size > 0 && downloaded != expected_size {
        return Err(format!("下载数据不完整：{} / {expected_size} 字节", downloaded));
    }
    Ok(())
}

static RUNNING_DOWNLOAD: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn app_update_download(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RUNNING_DOWNLOAD.try_lock().map_err(|_| "已有下载正在进行".to_string())?;
        let Some((_, assets)) = fetch_latest_release() else {
            return Err("未获取到可用发布版本，无法下载".into());
        };
        let Some(asset) = pick_asset(&assets) else {
            return Err("发布版本中没有本平台的安装包资产".into());
        };
        let dir = updates_dir(&app)?;
        download_asset(&app, &asset, &dir)
    })
    .await
    .map_err(|e| format!("下载任务失败：{e}"))?
    .map(|path| path.to_string_lossy().into_owned())
}

/// 仅允许启动 updates 目录内的 .exe；macOS 不支持应用内安装，引导用户去发布页。
#[tauri::command]
pub fn app_update_install(app: AppHandle, path: String) -> Result<(), String> {
    if cfg!(not(target_os = "windows")) {
        return Err("当前平台不支持应用内安装，请前往发布页下载".into());
    }
    let updates = updates_dir(&app)?;
    let requested = Path::new(&path);
    let Ok(canonical) = requested.canonicalize() else {
        return Err("安装包路径无效".into());
    };
    let Ok(updates_canonical) = updates.canonicalize() else {
        return Err("更新目录无效".into());
    };
    if !canonical.starts_with(&updates_canonical) || canonical.extension().and_then(|e| e.to_str()) != Some("exe") {
        return Err("只能启动应用内下载的安装包".into());
    }
    std::process::Command::new(&canonical)
        .spawn()
        .map_err(|e| format!("无法启动安装程序：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_matches_semver_segments() {
        assert_eq!(compare_versions("0.1.245", "v0.2.0"), Some(true));
        assert_eq!(compare_versions("0.1.245", "v0.1.245"), Some(false));
        assert_eq!(compare_versions("0.1.245", "v0.1.244"), Some(false));
        assert_eq!(compare_versions("0.1.245", "v0.1.245.1"), Some(true));
        assert_eq!(compare_versions("0.1", "v0.1.0"), Some(false));
        assert_eq!(compare_versions("0.1.245-rc1", "v0.1.246"), Some(true));
        assert_eq!(compare_versions("abc", "v0.1.0"), None);
        assert_eq!(compare_versions("0.1.245", ""), None);
    }

    #[test]
    fn empty_status_carries_current_version_without_update() {
        let status = empty_status("0.1.245");
        assert_eq!(status.current_version, "0.1.245");
        assert!(!status.update_available);
        assert!(status.latest_version.is_empty());
    }

    #[test]
    fn pick_asset_prefers_windows_setup_exe() {
        let assets = vec![
            Asset { name: "HachimoDock_0.1.246_macOS-arm64.dmg".into(), url: "u1".into(), size: 1 },
            Asset { name: "HachimoDock_0.1.246_Windows-x64-setup.exe".into(), url: "u2".into(), size: 2 },
            Asset { name: "SHA256SUMS".into(), url: "u3".into(), size: 3 },
        ];
        let picked = pick_asset(&assets).expect("windows asset");
        assert_eq!(picked.name, "HachimoDock_0.1.246_Windows-x64-setup.exe");
        assert!(pick_asset(&[]).is_none());
    }

    #[test]
    fn pick_asset_never_mixes_architectures_in_one_release() {
        let assets = vec![
            Asset { name: "HachimoDock_0.1.246_Windows-arm64-setup.exe".into(), url: "a".into(), size: 1 },
            Asset { name: "HachimoDock_0.1.246_Windows-x64-setup.exe".into(), url: "x".into(), size: 2 },
        ];
        let picked = pick_asset(&assets).expect("windows asset");
        let expected = if cfg!(target_arch = "aarch64") {
            "HachimoDock_0.1.246_Windows-arm64-setup.exe"
        } else {
            "HachimoDock_0.1.246_Windows-x64-setup.exe"
        };
        assert_eq!(picked.name, expected);
    }

}
