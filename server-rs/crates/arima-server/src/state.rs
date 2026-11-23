// SPDX-License-Identifier: AGPL-3.0-or-later

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use arima_agents::AgentSupervisor;
use arima_auth::{AuthError, AuthService, VaultKey};
use arima_core::VoiceProvider;
use arima_db::{
    ConnectionsRepo, Db, DecisionsRepo, FactoryRepo, FeedbackRepo, FindingsRepo, GatesRepo,
    MeetingsRepo, MemoryRepo, OutboxRepo, ProjectScope, UsageRepo, VaultSecretMeta,
    VaultSecretRepo,
};
use arima_proxy::{
    normalize_preview_domain, normalize_strict_origin, ContainerIpRegistry,
    DynamicScopePolicyProvider, EgressPolicy, PreviewRegistry, PreviewTokenSigner,
};
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use url::Url;

use crate::backups::DEFAULT_BACKUP_RETENTION;
use crate::github::GithubSyncService;
use crate::license::LicenseService;
use crate::mcp::McpRegistry;
use crate::meetings::StandupScheduler;
use crate::ws::WsHub;

/// Extracts the peer IP from `ConnectInfo<SocketAddr>` when present, defaulting to `127.0.0.1`
/// inside in-process `oneshot` tests where no TCP listener exists.
#[derive(Debug, Clone, Copy)]
pub struct PeerIp(pub IpAddr);

impl<S: Send + Sync> FromRequestParts<S> for PeerIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip())
            .unwrap_or_else(|| "127.0.0.1".parse().expect("valid loopback IP"));
        Ok(Self(ip))
    }
}

/// Configuration options for constructing [`AppState`].
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub preview_port: u16,
    pub bootstrap_token: String,
    pub local_origins: Vec<String>,
    pub allowed_origins: Vec<String>,
    pub preview_origin: Option<String>,
    pub trust_proxy: bool,
    pub same_origin: bool,
    pub data_root: Option<PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 7420,
            preview_port: 7421,
            bootstrap_token: uuid::Uuid::new_v4().to_string().replace('-', ""),
            local_origins: vec![
                "http://127.0.0.1:7420".into(),
                "http://localhost:7420".into(),
                "http://127.0.0.1:5173".into(),
                "http://localhost:5173".into(),
            ],
            allowed_origins: vec![],
            preview_origin: None,
            trust_proxy: false,
            same_origin: false,
            data_root: None,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<AppStateInner>,
}

pub struct AppStateInner {
    pub db: Db,
    pub auth: AuthService,
    pub outbox: OutboxRepo,
    pub decisions: DecisionsRepo,
    pub feedback: FeedbackRepo,
    pub findings: FindingsRepo,
    pub factory: FactoryRepo,
    pub connections: ConnectionsRepo,
    pub license: LicenseService,
    pub meetings: MeetingsRepo,
    pub memory: MemoryRepo,
    pub vault_secrets: VaultSecretRepo,
    pub gates: GatesRepo,
    pub usage: UsageRepo,
    pub supervisor: AgentSupervisor,
    pub runtime: crate::runtime::AgentRuntime,
    pub mcp: McpRegistry,
    pub standups: StandupScheduler,
    pub github: GithubSyncService,
    pub egress_policy: Arc<DynamicScopePolicyProvider>,
    pub preview_registry: PreviewRegistry,
    pub preview_signer: PreviewTokenSigner,
    pub ws_hub: WsHub,
    pub config: ServerConfig,
    pub public_origin: RwLock<Option<String>>,
    pub preview_domain: RwLock<Option<String>>,
    pub active_voice_provider: RwLock<VoiceProvider>,
    pub fallback_backups_dir: PathBuf,
    pub backup_retention: usize,
    /// MCP live checks per project in the current minute: (window start, count).
    pub mcp_checks: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>,
}

impl AppState {
    #[must_use]
    pub fn new(db: Db, vault: VaultKey, config: ServerConfig) -> Self {
        let auth = AuthService::new(db.clone(), vault);
        let outbox = OutboxRepo::new(db.clone());
        let decisions = DecisionsRepo::new(db.clone());
        let feedback = FeedbackRepo::new(db.clone());
        let findings = FindingsRepo::new(db.clone());
        let factory = FactoryRepo::new(db.clone());
        let connections = ConnectionsRepo::new(db.clone());
        let license = LicenseService::new(db.clone());
        let meetings = MeetingsRepo::new(db.clone());
        let memory = MemoryRepo::new(db.clone());
        let vault_secrets = VaultSecretRepo::new(db.clone());
        let gates = GatesRepo::new(db.clone());
        let usage = UsageRepo::new(db.clone());
        let supervisor = AgentSupervisor::new(db.clone(), 1);
        let runtime = crate::runtime::AgentRuntime::new(crate::runtime::RuntimeConfig::from_env(config.data_root.as_deref()));
        let mcp = McpRegistry::new(db.clone());
        let standups = StandupScheduler::new();
        let github = GithubSyncService::new(db.clone());
        let egress_policy = Arc::new(DynamicScopePolicyProvider::new(EgressPolicy::default()));
        let preview_registry = PreviewRegistry::new(ContainerIpRegistry::new());
        let preview_signer = PreviewTokenSigner::ephemeral();
        let fallback_backups_dir =
            std::env::temp_dir().join(format!("arima-backups-{}", uuid::Uuid::new_v4()));

        let state = Self {
            inner: Arc::new(AppStateInner {
                db,
                auth,
                outbox,
                decisions,
                feedback,
                findings,
                factory,
                connections,
                license,
                meetings,
                memory,
                vault_secrets,
                gates,
                usage,
                supervisor,
                runtime,
                mcp,
                standups,
                github,
                egress_policy,
                preview_registry,
                preview_signer,
                ws_hub: WsHub::new(),
                config,
                public_origin: RwLock::new(None),
                preview_domain: RwLock::new(None),
                active_voice_provider: RwLock::new(VoiceProvider::BrowserWebSpeech),
                fallback_backups_dir,
                backup_retention: DEFAULT_BACKUP_RETENTION,
                mcp_checks: std::sync::Mutex::default(),
            }),
        };
        state.sync_all_persisted_scopes_to_proxy();
        state
    }

    /// Synchronizes all persisted project scopes into `arima-proxy`'s live `DynamicScopePolicyProvider`.
    pub fn sync_all_persisted_scopes_to_proxy(&self) {
        let ids: Vec<String> = self
            .inner
            .db
            .read(|conn| {
                let mut stmt = conn.prepare("SELECT id FROM projects WHERE archived = 0")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r?);
                }
                Ok::<_, arima_db::DbError>(out)
            })
            .unwrap_or_default();
        for pid in ids {
            if let Ok(scope) = self.inner.findings.get_scope(&pid) {
                if !scope.in_scope.is_empty() || !scope.out_of_scope.is_empty() {
                    let _ = self.sync_project_scope_to_proxy(&pid, &scope);
                }
            }
        }
    }

    /// Synchronizes one project's engagement scope directly into `arima-proxy` `EgressPolicy`,
    /// returning any IMDS / link-local entries that were forcibly stripped.
    #[must_use]
    pub fn sync_project_scope_to_proxy(
        &self,
        project_id: &str,
        scope: &ProjectScope,
    ) -> Vec<String> {
        self.inner.egress_policy.sync_project_scope(
            project_id,
            &scope.in_scope,
            &scope.out_of_scope,
            true,
        )
    }

    #[must_use]
    pub fn active_voice_provider(&self) -> VoiceProvider {
        self.inner
            .active_voice_provider
            .read()
            .map(|g| *g)
            .unwrap_or(VoiceProvider::BrowserWebSpeech)
    }

    pub fn set_active_voice_provider(&self, provider: VoiceProvider) {
        if let Ok(mut guard) = self.inner.active_voice_provider.write() {
            *guard = provider;
        }
    }

    /// Encrypts and persists a provider API secret inside SQLite `vault_secrets` using `VaultKey`.
    pub fn store_vault_secret(
        &self,
        id: Option<&str>,
        scope: &str,
        provider: &str,
        label: &str,
        plaintext_secret: &str,
    ) -> Result<VaultSecretMeta, AuthError> {
        let clean_secret = plaintext_secret.trim();
        if clean_secret.is_empty() {
            return Err(AuthError::Validation("secret value must not be empty".into()));
        }
        let secret_id = id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("sec-{}", uuid::Uuid::new_v4().simple()));
        let aad = format!("vault-secret:{secret_id}");
        let enc = self
            .inner
            .auth
            .vault()
            .encrypt(aad.as_bytes(), clean_secret.as_bytes())?;
        self.inner
            .vault_secrets
            .upsert(&secret_id, scope, provider, label, &enc)
            .map_err(|e| AuthError::Validation(e.to_string()))
    }

    /// Configures production HTTPS cloud reverse-proxy settings (`HQ_PUBLIC_ORIGIN`, `HQ_PREVIEW_DOMAIN`).
    pub fn configure_cloud_proxy(
        &self,
        public_origin: Option<String>,
        preview_domain: Option<String>,
    ) {
        if let Ok(mut guard) = self.inner.public_origin.write() {
            *guard = public_origin.and_then(|o| normalize_strict_origin(&o));
        }
        if let Ok(mut guard) = self.inner.preview_domain.write() {
            *guard = preview_domain.and_then(|d| normalize_preview_domain(&d));
        }
    }

    #[must_use]
    pub fn public_origin(&self) -> Option<String> {
        self.inner
            .public_origin
            .read()
            .ok()
            .and_then(|g| g.clone())
    }

    #[must_use]
    pub fn preview_domain(&self) -> Option<String> {
        self.inner
            .preview_domain
            .read()
            .ok()
            .and_then(|g| g.clone())
    }

    #[must_use]
    pub fn preview_origin(&self) -> String {
        self.inner
            .config
            .preview_origin
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", self.inner.config.preview_port))
    }

    #[must_use]
    pub fn is_local_origin(&self, origin: Option<&str>, peer_ip: IpAddr, host_hdr: Option<&str>) -> bool {
        let Some(orig) = origin else {
            return false;
        };
        let normalized = orig.trim_end_matches('/');
        if self
            .inner
            .config
            .local_origins
            .iter()
            .any(|o| o.trim_end_matches('/') == normalized)
        {
            return true;
        }
        if peer_ip.is_loopback() && is_loopback_origin(normalized) {
            if let Some(host) = host_hdr {
                if let Ok(u) = Url::parse(normalized) {
                    if let Some(oh) = u.host_str() {
                        let req_host = host.split(':').next().unwrap_or("");
                        return oh.eq_ignore_ascii_case(req_host);
                    }
                }
            }
            return true;
        }
        false
    }

    #[must_use]
    pub fn is_allowed_origin(&self, origin: Option<&str>, host_hdr: Option<&str>) -> bool {
        let Some(orig) = origin else {
            return true;
        };
        let normalized = orig.trim_end_matches('/');
        if self
            .inner
            .config
            .local_origins
            .iter()
            .chain(self.inner.config.allowed_origins.iter())
            .any(|o| o.trim_end_matches('/') == normalized)
        {
            return true;
        }
        if let Some(ref pub_origin) = self.public_origin() {
            if pub_origin.trim_end_matches('/') == normalized {
                return true;
            }
        }
        if let Some(host) = host_hdr {
            if let Ok(u) = Url::parse(normalized) {
                let port_part = u.port().map(|p| format!(":{p}")).unwrap_or_default();
                let authority = format!("{}{}", u.host_str().unwrap_or(""), port_part);
                if authority.eq_ignore_ascii_case(host) {
                    return true;
                }
            }
        }
        false
    }

    pub fn ensure_default_project(&self, name: &str, slug: &str, root_path: &str) -> Result<(), arima_db::DbError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.inner.db.transaction(|conn| {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))?;
            if count == 0 {
                let id = format!("proj-{slug}");
                conn.execute(
                    "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    rusqlite::params![id, slug, name, root_path, now_ms],
                )?;
            }
            Ok::<_, arima_db::DbError>(())
        })
    }

    pub fn default_project(&self) -> Option<(String, String, String, String)> {
        self.inner
            .db
            .read(|conn| {
                use rusqlite::OptionalExtension;
                conn.query_row(
                    "SELECT id, slug, name, root_path FROM projects WHERE archived = 0 ORDER BY created_at ASC LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(arima_db::DbError::from)
            })
            .ok()
            .flatten()
    }
}

fn is_loopback_origin(origin: &str) -> bool {
    let Ok(u) = Url::parse(origin) else {
        return false;
    };
    matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}
