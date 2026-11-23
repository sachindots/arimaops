// SPDX-License-Identifier: AGPL-3.0-or-later

//! ArimaOps v2.0 HTTP, WebSocket, MCP, and embedded UI server crate.

pub mod backups;
pub mod cli;
pub mod delivery;
pub mod factory;
pub mod github;
pub mod integrations;
pub mod key_test;
pub mod license;
pub mod mcp;
pub mod meetings;
pub mod memory;
pub mod memory_cmds;
pub mod planning;
pub mod preview;
pub mod routes;
pub mod runtime;
pub mod secrets;
pub(crate) mod routes_m4;
pub(crate) mod routes_m5;
pub mod security;
pub mod skill_scan;
pub mod skills;
pub mod state;
pub mod usage_watch;
pub mod team;
pub mod team_edit;
pub mod voice;
pub mod ws;

use arima_auth::VaultKey;
use arima_db::Db;
use axum::Router;

pub use routes::router_with_state;
pub use state::{AppState, ServerConfig};

/// Builds a default in-memory router (used for health checks and lightweight unit tests).
pub fn build_router() -> Router {
    let db = Db::open_in_memory().expect("in-memory sqlite db");
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    router_with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_endpoint_returns_rust_v2_status() {
        let app = build_router();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["engine"], "rust");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    }
}
