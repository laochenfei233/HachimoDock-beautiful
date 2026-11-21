//! Weather provider credentials entered in Settings: QWeather API key and Caiyun
//! token. Keys live only in this PC's OS credential store (owner-only file on
//! unix) and never enter packages, snapshots, logs, or error strings. The
//! QWeather API host is per-account since 2024 and is not a secret; it stays in
//! a plain config file beside the other app settings.

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{Mutex, OnceLock}};

pub const QWEATHER: &str = "qweather";
pub const CAIYUN: &str = "caiyun";
pub const DEFAULT_QWEATHER_HOST: &str = "devapi.qweather.com";
const SERVICE: &str = "com.petmanager.desktop.weather";

#[derive(Clone, Debug, Default, Serialize)]
pub struct QWeatherStatus {
    pub configured: bool,
    pub host: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub qweather: QWeatherStatus,
    pub caiyun: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostConfig {
    #[serde(default)]
    qweather_host: String,
}

static ROOT: OnceLock<Mutex<PathBuf>> = OnceLock::new();

/// Called once at app startup with the app data directory.
pub fn configure(root: PathBuf) {
    ROOT.get_or_init(|| Mutex::new(root.join("weather-providers")));
}

#[cfg(test)]
pub(crate) fn configure_for_test(root: PathBuf) {
    let target = root.clone();
    ROOT.get_or_init(|| Mutex::new(root)).lock().unwrap().clone_from(&target);
}

fn root() -> PathBuf {
    ROOT.get_or_init(|| Mutex::new(std::env::temp_dir().join("pet-weather-unconfigured")))
        .lock().unwrap().clone()
}

#[cfg(windows)]
fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|_| "无法打开系统凭据存储".to_string())
}

#[cfg(windows)]
pub fn load_key(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据".to_string()),
    }
}

#[cfg(windows)]
fn store_key(provider: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => entry(provider)?.set_password(value).map_err(|_| "无法保存凭据".to_string()),
        None => match entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法删除凭据".to_string()),
        },
    }
}

#[cfg(not(windows))]
fn token_path(provider: &str) -> Result<PathBuf, String> {
    use std::fs;
    let dir = root().join("private");
    fs::create_dir_all(&dir).map_err(|_| "无法创建凭据目录".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护凭据目录".to_string())?;
    }
    Ok(dir.join(format!("{provider}.key")))
}

#[cfg(not(windows))]
pub(crate) fn load_key(provider: &str) -> Result<Option<String>, String> {
    match std::fs::read(token_path(provider)?) {
        Ok(bytes) if bytes.len() <= 8192 => Ok(Some(String::from_utf8(bytes).map_err(|_| "凭据损坏".to_string())?)),
        Ok(_) => Err("凭据文件过大".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取凭据".to_string()),
    }
}

#[cfg(not(windows))]
fn store_key(provider: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => std::fs::write(token_path(provider)?, value).map_err(|_| "无法保存凭据".to_string()),
        None => match std::fs::remove_file(token_path(provider)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法删除凭据".to_string()),
        },
    }
}

pub fn qweather_host() -> String {
    let raw = std::fs::read(host_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HostConfig>(&bytes).ok())
        .map(|config| config.qweather_host)
        .unwrap_or_default();
    let host = raw.trim().to_ascii_lowercase();
    if host.is_empty() { DEFAULT_QWEATHER_HOST.to_string() } else { host }
}

fn host_path() -> PathBuf {
    root().join("weather-provider.json")
}

fn store_qweather_host(host: &str) -> Result<(), String> {
    std::fs::create_dir_all(root()).map_err(|_| "无法保存设置".to_string())?;
    let body = serde_json::to_vec(&HostConfig { qweather_host: host.to_string() }).map_err(|_| "设置无效".to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(root()).map_err(|_| "无法保存设置".to_string())?;
    std::io::Write::write_all(&mut file, &body).map_err(|_| "无法保存设置".to_string())?;
    file.persist(host_path()).map(|_| ()).map_err(|_| "无法保存设置".to_string())
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && host.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

#[tauri::command]
pub fn weather_key_status() -> Status {
    Status {
        qweather: QWeatherStatus {
            configured: load_key(QWEATHER).ok().flatten().is_some(),
            host: qweather_host(),
        },
        caiyun: load_key(CAIYUN).ok().flatten().is_some(),
    }
}

/// Empty value keeps the stored key unchanged; the key itself is never echoed back.
#[tauri::command]
pub fn save_weather_key(provider: String, value: String, qweather_host: Option<String>) -> Result<Status, String> {
    if provider != QWEATHER && provider != CAIYUN {
        return Err("未知的天气提供器".into());
    }
    let value = value.trim();
    // Validate everything before any write: a rejected host must not leave a
    // half-saved key behind. A blank host keeps the current one (which starts
    // at DEFAULT_QWEATHER_HOST); typing the default explicitly restores it.
    let mut host_update = None;
    if provider == QWEATHER {
        if let Some(raw_host) = qweather_host {
            let host = raw_host.trim().to_ascii_lowercase();
            if !host.is_empty() {
                if !valid_host(&host) {
                    return Err("API Host 格式无效".into());
                }
                host_update = Some(host);
            }
        }
    }
    if !value.is_empty() {
        if value.len() > 128 || value.chars().any(char::is_control) {
            return Err("Key 格式无效".into());
        }
        store_key(&provider, Some(value))?;
    }
    if let Some(host) = host_update {
        store_qweather_host(&host)?;
    }
    Ok(weather_key_status())
}

/// Clears one provider key; used by the settings page's explicit 清除 control.
#[tauri::command]
pub fn clear_weather_key(provider: String) -> Result<Status, String> {
    if provider != QWEATHER && provider != CAIYUN {
        return Err("未知的天气提供器".into());
    }
    store_key(&provider, None)?;
    Ok(weather_key_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_config_roundtrip_and_defaults() {
        let root = std::env::temp_dir().join(format!("pet-weather-keys-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        configure_for_test(root.clone());
        assert_eq!(qweather_host(), DEFAULT_QWEATHER_HOST);
        store_qweather_host("abc123.re.qweatherapi.com").unwrap();
        assert_eq!(qweather_host(), "abc123.re.qweatherapi.com");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn host_validation_rejects_bad_shapes() {
        assert!(!valid_host("devapi"));
        assert!(!valid_host("127.0.0.1"));
        assert!(!valid_host(".a.b"));
        assert!(!valid_host("a..b"));
        assert!(valid_host("devapi.qweather.com"));
        assert!(valid_host("abc123.re.qweatherapi.com"));
    }

    #[test]
    fn save_with_blank_host_keeps_existing_host() {
        let root = std::env::temp_dir().join(format!("pet-weather-keys-blank-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        configure_for_test(root.clone());
        store_qweather_host("abc123.re.qweatherapi.com").unwrap();
        save_weather_key("qweather".into(), "".into(), Some("   ".into())).unwrap();
        save_weather_key("qweather".into(), "".into(), None).unwrap();
        assert_eq!(qweather_host(), "abc123.re.qweatherapi.com");
        save_weather_key("qweather".into(), "".into(), Some("devapi.qweather.com".into())).unwrap();
        assert_eq!(qweather_host(), DEFAULT_QWEATHER_HOST);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_unconfigured_without_error() {
        let root = std::env::temp_dir().join(format!("pet-weather-keys-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        configure_for_test(root.clone());
        // A real OS vault entry may or may not exist; status must never fail.
        let status = weather_key_status();
        assert_eq!(status.qweather.host, DEFAULT_QWEATHER_HOST);
        let _ = std::fs::remove_dir_all(&root);
    }
}
