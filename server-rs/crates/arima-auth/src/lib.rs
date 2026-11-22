// SPDX-License-Identifier: AGPL-3.0-or-later

//! Authentication, Argon2id password hashing, WebAuthn Passkeys, vault-encrypted QR TOTP,
//! per-project RBAC (`owner`/`operator`/`viewer`), persistent throttling, and security audit logging.

pub mod audit;
pub mod cookies;
pub mod error;
pub mod passkeys;
pub mod password;
pub mod rbac;
pub mod service;
pub mod throttle;
pub mod totp;
pub mod vault;

pub use audit::{list_audit, record_audit, redact_json_value, AuditWrite};
pub use cookies::{
    build_clear_cookie, build_session_cookie, extract_client_ip, parse_cookie, SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECS,
};
pub use error::{AuthError, Result};
pub use passkeys::{
    origin_supports_passkeys, PasskeyService, PasskeyStartAuthResponse, PasskeyStartRegResponse,
};
pub use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};
pub use rbac::{authorize_command, effective_role, AuthContext, CommandVerdict};
pub use service::{
    AuthService, CreateUserOutcome, LoginSuccess, SessionMeta, UpdateUserInput, UpdateUserOutcome,
    VerifiedSession,
};
pub use throttle::AuthThrottle;
pub use vault::VaultKey;

#[cfg(test)]
mod tests {
    use super::*;
    use arima_core::ServerRole;
    use arima_db::{Db, DbError};
    use chrono::Utc;
    use std::net::{IpAddr, Ipv4Addr};

    fn test_service() -> AuthService {
        let db = Db::open_in_memory().unwrap();
        let vault = VaultKey::from_bytes([7u8; 32]);
        AuthService::new(db, vault)
    }

    #[test]
    fn bootstrap_token_respects_local_vs_remote_once_users_exist() {
        let svc = test_service();
        let (tok, _) = svc
            .exchange_bootstrap_token("boot-secret", "boot-secret", false, None, "Phone".into())
            .unwrap();
        assert!(svc.verify_session(&tok, false).unwrap().is_some());

        // Add an owner user -> remote bootstrap session must stop working immediately.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            svc.create_user("Sachin".into(), "password-1234".into(), ServerRole::Owner)
                .await
                .unwrap();
        });
        assert!(svc.verify_session(&tok, false).unwrap().is_none());
        assert!(svc
            .exchange_bootstrap_token("boot-secret", "boot-secret", false, None, "Phone".into())
            .is_err());
        // Local bootstrap link still works on the host machine.
        assert!(svc
            .exchange_bootstrap_token("boot-secret", "boot-secret", true, None, "Host".into())
            .is_ok());
    }

    #[test]
    fn vault_round_trip_and_aad_binding() {
        let vault = VaultKey::from_bytes([9u8; 32]);
        let enc = vault.encrypt(b"totp:u1", b"SECRET32").unwrap();
        assert_eq!(vault.decrypt(b"totp:u1", &enc).unwrap(), b"SECRET32");
        assert!(vault.decrypt(b"totp:u2", &enc).is_err());
    }

    #[test]
    fn cookie_parser_rejects_malformed_percent_encoding_safely() {
        assert_eq!(
            parse_cookie("foo=bar; hq_sid=abc123; baz=1", SESSION_COOKIE_NAME).unwrap(),
            Some("abc123".into())
        );
        assert!(matches!(
            parse_cookie("hq_sid=%E0%A4%A", SESSION_COOKIE_NAME),
            Err(AuthError::MalformedCookie)
        ));
        assert!(matches!(
            parse_cookie("hq_sid=%ZZ", SESSION_COOKIE_NAME),
            Err(AuthError::MalformedCookie)
        ));
    }

    #[test]
    fn client_ip_ignores_spoofed_xff_unless_trusted() {
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(
            extract_client_ip(peer, Some("203.0.113.99"), false),
            "127.0.0.1"
        );
        assert_eq!(
            extract_client_ip(peer, Some("198.51.100.1, 203.0.113.99"), true),
            "203.0.113.99"
        );
    }

    #[test]
    fn passkey_origin_check_allows_localhost_and_https_domains_only() {
        assert!(origin_supports_passkeys("http://localhost:7496"));
        assert!(origin_supports_passkeys("https://hq.tailnet.ts.net"));
        assert!(!origin_supports_passkeys("http://127.0.0.1:7496"));
        assert!(!origin_supports_passkeys("http://192.168.1.50:7420"));
        assert!(!origin_supports_passkeys("https://127.0.0.1:7496"));
    }

    #[test]
    fn totp_generates_svg_qr_and_blocks_replay() {
        let db = Db::open_in_memory().unwrap();
        db.transaction(|c| {
            c.execute(
                "INSERT INTO users (id, name, password_hash, role, created_at) VALUES ('u1', 'sachin', 'h', 'owner', 1)",
                [],
            )?;
            Ok::<_, DbError>(())
        })
        .unwrap();

        let secret = totp::generate_secret_b32();
        let uri = totp::otpauth_uri("sachin", &secret);
        let svg = totp::render_qr_svg(&uri).unwrap();
        assert!(svg.contains("<svg"));

        let now_secs = 1_763_720_010;
        let step = now_secs / 30;
        let code = totp::totp_code_for_step(&secret, step).unwrap();

        assert!(totp::verify_totp_for_user(&db, "u1", &secret, &code, now_secs).unwrap());
        // Second use in same step must be rejected.
        assert!(!totp::verify_totp_for_user(&db, "u1", &secret, &code, now_secs).unwrap());
    }

    #[test]
    fn rbac_blocks_viewer_prompt_injection_and_operator_escapes() {
        let viewer_ctx = AuthContext {
            server_role: ServerRole::Viewer,
            project_role: None,
            remote: false,
            elevated: false,
            target_agent_local: false,
            decision_owner_only: false,
        };
        assert!(matches!(
            authorize_command("sendMessage", &viewer_ctx),
            CommandVerdict::Denied(_)
        ));
        assert!(matches!(
            authorize_command("askTeam", &viewer_ctx),
            CommandVerdict::Denied(_)
        ));
        assert_eq!(
            authorize_command("recheckSetup", &viewer_ctx),
            CommandVerdict::Allowed
        );

        let operator_local_ctx = AuthContext {
            server_role: ServerRole::Operator,
            project_role: None,
            remote: false,
            elevated: false,
            target_agent_local: true,
            decision_owner_only: true,
        };
        assert!(matches!(
            authorize_command("setEnvVar", &operator_local_ctx),
            CommandVerdict::Denied(_)
        ));
        assert!(matches!(
            authorize_command("recordGate", &operator_local_ctx),
            CommandVerdict::Denied(_)
        ));
        assert!(matches!(
            authorize_command("openHostShell", &operator_local_ctx),
            CommandVerdict::Denied(_)
        ));

        let operator_sandbox_ctx = AuthContext {
            server_role: ServerRole::Operator,
            project_role: None,
            remote: false,
            elevated: false,
            target_agent_local: false,
            decision_owner_only: false,
        };
        assert_eq!(
            authorize_command("startAgent", &operator_sandbox_ctx),
            CommandVerdict::Allowed
        );
    }

    #[tokio::test]
    async fn throttle_persists_across_service_restart_and_admin_reset_revokes_sessions() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("arima.db");
        let db = Db::open(&db_path).unwrap();
        let vault = VaultKey::from_bytes([11u8; 32]);
        let svc = AuthService::new(db.clone(), vault.clone());

        // First user becomes Owner automatically even if Operator requested.
        let created = svc
            .create_user(
                "Sachin".into(),
                "correct-horse-battery".into(),
                ServerRole::Viewer,
            )
            .await
            .unwrap();
        assert_eq!(created.user.role, ServerRole::Owner);
        assert!(created.qr_svg.contains("<svg"));

        let login = svc
            .login_with_password(
                "sachin".into(),
                "correct-horse-battery".into(),
                SessionMeta {
                    client_ip: "127.0.0.1".into(),
                    origin: Some("http://localhost:7496".into()),
                    label: "Test Browser".into(),
                    remote: false,
                },
            )
            .await
            .unwrap();
        assert!(svc.verify_session(&login.raw_token, false).unwrap().is_some());

        // Admin password reset immediately invalidates the existing session.
        let reset = svc
            .update_user(
                &created.user.id,
                UpdateUserInput {
                    password: Some("brand-new-secret-pw".into()),
                    reset_totp: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(reset.revoked_device_ids, vec![login.session.id.clone()]);
        assert!(reset.qr_svg.as_deref().unwrap().contains("<svg"));
        assert!(svc.verify_session(&login.raw_token, false).unwrap().is_none());

        // 5 bad login attempts trigger persistent throttle across fresh AuthService instance.
        for _ in 0..5 {
            let err = svc
                .login_with_password(
                    "sachin".into(),
                    "wrong-password-123".into(),
                    SessionMeta {
                        client_ip: "10.0.0.2".into(),
                        origin: None,
                        label: "X".into(),
                        remote: true,
                    },
                )
                .await
                .unwrap_err();
            assert!(matches!(err, AuthError::InvalidCredentials));
        }

        drop(svc);
        drop(db);
        let db2 = Db::open(&db_path).unwrap();
        let svc2 = AuthService::new(db2, vault);
        let err = svc2
            .login_with_password(
                "sachin".into(),
                "brand-new-secret-pw".into(),
                SessionMeta {
                    client_ip: "10.0.0.2".into(),
                    origin: None,
                    label: "X".into(),
                    remote: true,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::Throttled { .. }));
    }

    #[test]
    fn persistent_throttle_clears_after_window() {
        let db = Db::open_in_memory().unwrap();
        let throttle = AuthThrottle::new(db);
        let t0 = Utc::now().timestamp_millis();
        for _ in 0..5 {
            throttle
                .record_failure("b1", 5, 60_000, 30_000, t0)
                .unwrap();
        }
        assert!(matches!(
            throttle.check_locked("b1", t0 + 10_000),
            Err(AuthError::Throttled { .. })
        ));
        assert!(throttle.check_locked("b1", t0 + 31_000).is_ok());
    }
}
