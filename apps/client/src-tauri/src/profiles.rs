// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("invalid server url: {0}")]
    InvalidUrl(String),
    #[error("invalid profile name: {0}")]
    InvalidName(String),
    #[error("profile not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ProfileError>;

/// Saved ArimaOps HQ server endpoint shown in the client server picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Persisted list of saved HQ servers and the most recently connected server id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreData {
    pub profiles: Vec<ServerProfile>,
    pub last_active_id: Option<String>,
}

impl Default for ProfileStoreData {
    fn default() -> Self {
        Self {
            profiles: vec![ServerProfile {
                id: "local-hq".into(),
                name: "Local HQ".into(),
                url: "http://localhost:7420".into(),
                created_at: Utc::now().to_rfc3339(),
                last_used_at: None,
            }],
            last_active_id: Some("local-hq".into()),
        }
    }
}

/// Result of probing `<server_url>/api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthProbeResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub engine: Option<String>,
    pub version: Option<String>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Validates and normalizes an HQ server URL.
///
/// Strictly allows ONLY `http://` and `https://` URLs with a valid host and zero embedded
/// credentials, blocking `javascript:`, `file:`, `data:`, `tauri:`, and other dangerous schemes.
pub fn validate_server_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProfileError::InvalidUrl("URL cannot be empty".into()));
    }
    let parsed = Url::parse(trimmed)
        .map_err(|e| ProfileError::InvalidUrl(format!("malformed URL: {e}")))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ProfileError::InvalidUrl(format!(
            "scheme '{}' is not allowed; use http:// or https://",
            parsed.scheme()
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ProfileError::InvalidUrl(
            "embedded username/password credentials are not allowed in server URLs".into(),
        ));
    }
    let Some(host) = parsed.host_str() else {
        return Err(ProfileError::InvalidUrl("URL must include a hostname".into()));
    };
    if host.is_empty() {
        return Err(ProfileError::InvalidUrl("URL hostname cannot be empty".into()));
    }

    let mut normalized = format!("{}://{host}", parsed.scheme());
    if let Some(port) = parsed.port() {
        normalized.push_str(&format!(":{port}"));
    }
    let path = parsed.path().trim_end_matches('/');
    if !path.is_empty() && path != "/" {
        normalized.push_str(path);
    }
    Ok(normalized)
}

/// Persistent atomic JSON store (`0600` on Unix) for saved HQ server profiles.
#[derive(Debug, Clone)]
pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads saved profiles from disk, seeding a default `Local HQ` profile on first launch.
    pub fn load(&self) -> Result<ProfileStoreData> {
        if !self.path.exists() {
            return Ok(ProfileStoreData::default());
        }
        let bytes = fs::read(&self.path)?;
        let data: ProfileStoreData = serde_json::from_slice(&bytes)?;
        Ok(data)
    }

    /// Atomically persists profiles via write-temp (`0600` on Unix) + fsync + rename.
    pub fn save(&self, data: &ProfileStoreData) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    if !parent.exists() {
                        fs::DirBuilder::new()
                            .recursive(true)
                            .mode(0o700)
                            .create(parent)?;
                    }
                }
                #[cfg(not(unix))]
                {
                    fs::create_dir_all(parent)?;
                }
            }
        }

        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let file_name = self
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("profiles.json");
        let tmp_path = self
            .path
            .with_file_name(format!(".{file_name}.tmp-{}-{seq}", std::process::id()));
        let payload = serde_json::to_vec_pretty(data)?;

        {
            #[cfg(unix)]
            let mut f = {
                use std::os::unix::fs::OpenOptionsExt;
                fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .mode(0o600)
                    .open(&tmp_path)?
            };
            #[cfg(not(unix))]
            let mut f = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)?;

            f.write_all(&payload)?;
            f.sync_all()?;
        }

        fs::rename(&tmp_path, &self.path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            ProfileError::Io(e)
        })?;
        Ok(())
    }

    /// Adds a new profile or updates an existing profile when `id` is `Some`.
    pub fn upsert(
        &self,
        id: Option<&str>,
        name: &str,
        url: &str,
    ) -> Result<(ServerProfile, ProfileStoreData)> {
        let clean_name = name.trim();
        if clean_name.is_empty() || clean_name.len() > 80 {
            return Err(ProfileError::InvalidName(
                "name must be between 1 and 80 characters".into(),
            ));
        }
        let clean_url = validate_server_url(url)?;
        let mut data = self.load()?;
        let now = Utc::now().to_rfc3339();

        let saved = if let Some(existing_id) = id.filter(|s| !s.trim().is_empty()) {
            let Some(found) = data.profiles.iter_mut().find(|p| p.id == existing_id) else {
                return Err(ProfileError::NotFound(existing_id.to_owned()));
            };
            found.name = clean_name.to_owned();
            found.url = clean_url;
            found.clone()
        } else {
            let profile = ServerProfile {
                id: format!("srv-{}", uuid::Uuid::new_v4().simple()),
                name: clean_name.to_owned(),
                url: clean_url,
                created_at: now,
                last_used_at: None,
            };
            data.profiles.push(profile.clone());
            profile
        };

        self.save(&data)?;
        Ok((saved, data))
    }

    /// Deletes a saved profile by `id`.
    pub fn delete(&self, id: &str) -> Result<ProfileStoreData> {
        let mut data = self.load()?;
        let before = data.profiles.len();
        data.profiles.retain(|p| p.id != id);
        if data.profiles.len() == before {
            return Err(ProfileError::NotFound(id.to_owned()));
        }
        if data.last_active_id.as_deref() == Some(id) {
            data.last_active_id = data.profiles.first().map(|p| p.id.clone());
        }
        self.save(&data)?;
        Ok(data)
    }

    /// Marks `id` as the most recently used active server and returns its validated URL.
    pub fn mark_active(&self, id: &str) -> Result<ServerProfile> {
        let mut data = self.load()?;
        let now = Utc::now().to_rfc3339();
        let Some(found) = data.profiles.iter_mut().find(|p| p.id == id) else {
            return Err(ProfileError::NotFound(id.to_owned()));
        };
        let validated = validate_server_url(&found.url)?;
        found.url = validated;
        found.last_used_at = Some(now);
        let cloned = found.clone();
        data.last_active_id = Some(cloned.id.clone());
        self.save(&data)?;
        Ok(cloned)
    }
}

fn probe_client() -> std::result::Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Probes `<server_url>/api/health` with a 10-second timeout to report reachability and version.
pub async fn probe_server_health(raw_url: &str) -> HealthProbeResult {
    let start = Instant::now();
    let base = match validate_server_url(raw_url) {
        Ok(u) => u,
        Err(err) => {
            return HealthProbeResult {
                ok: false,
                status: None,
                engine: None,
                version: None,
                latency_ms: 0,
                error: Some(err.to_string()),
            };
        }
    };

    let client = match probe_client() {
        Ok(c) => c,
        Err(err) => {
            return HealthProbeResult {
                ok: false,
                status: None,
                engine: None,
                version: None,
                latency_ms: 0,
                error: Some(err),
            };
        }
    };

    let health_url = format!("{}/api/health", base.trim_end_matches('/'));
    match client.get(&health_url).send().await {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            let latency_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
            if !resp.status().is_success() {
                return HealthProbeResult {
                    ok: false,
                    status: Some(status_code),
                    engine: None,
                    version: None,
                    latency_ms,
                    error: Some(format!("HTTP {status_code}")),
                };
            }
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let ok = body.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(true);
            let engine = body
                .get("engine")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let version = body
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            HealthProbeResult {
                ok,
                status: Some(status_code),
                engine,
                version,
                latency_ms,
                error: None,
            }
        }
        Err(err) => HealthProbeResult {
            ok: false,
            status: None,
            engine: None,
            version: None,
            latency_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
            error: Some(err.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn url_validation_allows_http_https_and_blocks_dangerous_schemes() {
        assert_eq!(
            validate_server_url("http://localhost:7420/").unwrap(),
            "http://localhost:7420"
        );
        assert_eq!(
            validate_server_url("https://hq.example.com/").unwrap(),
            "https://hq.example.com"
        );
        assert!(validate_server_url("javascript:alert(1)").is_err());
        assert!(validate_server_url("file:///etc/passwd").is_err());
        assert!(validate_server_url("data:text/html,hi").is_err());
        assert!(validate_server_url("ftp://example.com").is_err());
        assert!(validate_server_url("https://user:pass@hq.example.com").is_err());
        assert!(validate_server_url("").is_err());
    }

    #[test]
    fn profile_crud_persists_atomically_with_0600_permissions() {
        let dir = TempDir::new().unwrap();
        let store = ProfileStore::new(dir.path().join("cfg").join("profiles.json"));

        // Default profile seeded before first write.
        let initial = store.load().unwrap();
        assert_eq!(initial.profiles.len(), 1);
        assert_eq!(initial.profiles[0].url, "http://localhost:7420");

        // Add AWS production profile.
        let (aws, after_add) = store
            .upsert(None, "AWS Prod", "https://hq.example.com/")
            .unwrap();
        assert_eq!(after_add.profiles.len(), 2);
        assert_eq!(aws.url, "https://hq.example.com");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Edit profile name & URL.
        let (updated, _) = store
            .upsert(Some(&aws.id), "AWS Production", "https://hq.prod.example.com")
            .unwrap();
        assert_eq!(updated.name, "AWS Production");
        assert_eq!(updated.url, "https://hq.prod.example.com");

        // Mark active & reload from disk.
        let active = store.mark_active(&aws.id).unwrap();
        assert!(active.last_used_at.is_some());
        let reloaded = store.load().unwrap();
        assert_eq!(reloaded.last_active_id.as_deref(), Some(aws.id.as_str()));

        // Delete profile falls back last_active_id cleanly.
        let after_del = store.delete(&aws.id).unwrap();
        assert_eq!(after_del.profiles.len(), 1);
        assert_eq!(after_del.last_active_id.as_deref(), Some("local-hq"));
    }

    #[tokio::test]
    async fn health_probe_reports_online_rust_hq_and_rejects_bad_urls() {
        let bad = probe_server_health("file:///etc/passwd").await;
        assert!(!bad.ok);
        assert!(bad.error.is_some());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"ok":true,"engine":"rust","version":"2.0.0-alpha.0"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        });

        let res = probe_server_health(&format!("http://{addr}")).await;
        assert!(res.ok);
        assert_eq!(res.status, Some(200));
        assert_eq!(res.engine.as_deref(), Some("rust"));
        assert_eq!(res.version.as_deref(), Some("2.0.0-alpha.0"));
    }
}
