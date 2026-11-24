// SPDX-License-Identifier: AGPL-3.0-or-later

//! Values captured from the pre-upgrade RustCrypto stack. Issued licences and webhook
//! signatures must keep verifying byte for byte, so these constants must never be regenerated.

use arima_server::github::{compute_github_signature, verify_github_signature};
use arima_server::license::{sign_license_payload, verify_license_key, LicensePayload};
use ed25519_dalek::{SigningKey, VerifyingKey};

const PUBKEY_HEX: &str = "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618";
const LICENSE: &str = "ARIMA1.eyJsaWNlbnNlZSI6IkdvbGRlbiBUZXN0IE9yZyIsInRpZXIiOiJ0ZWFtIiwibWF4U2VhdHMiOjI1LCJtYXhQcm9qZWN0cyI6NTAsImV4cGlyZXNBdCI6IjIwOTktMDEtMDFUMDA6MDA6MDBaIiwiZmVhdHVyZXMiOlsic3NvIiwiYXVkaXQiXX0.nyAThT-EL88s8QoifOiFIhQhzbqzeX_5jommDkKthEFVHnXxmyEfHJOWVZ6ZYUyKzG9DSm44nGzZCnt3Ly5dAQ";

fn payload() -> LicensePayload {
    LicensePayload {
        licensee: "Golden Test Org".into(),
        tier: "team".into(),
        max_seats: 25,
        max_projects: 50,
        expires_at: "2099-01-01T00:00:00Z".into(),
        features: vec!["sso".into(), "audit".into()],
    }
}

fn pubkey() -> VerifyingKey {
    let bytes: [u8; 32] = hex::decode(PUBKEY_HEX).unwrap().try_into().unwrap();
    VerifyingKey::from_bytes(&bytes).unwrap()
}

#[test]
fn license_signed_before_upgrade_still_verifies() {
    assert_eq!(verify_license_key(&pubkey(), LICENSE).unwrap(), payload());
    let mut tampered = LICENSE.to_owned();
    tampered.replace_range(10..11, "x");
    assert!(verify_license_key(&pubkey(), &tampered).is_err());
}

#[test]
fn ed25519_signing_is_deterministic_across_upgrade() {
    let sk = SigningKey::from_bytes(&[9u8; 32]);
    assert_eq!(hex::encode(sk.verifying_key().to_bytes()), PUBKEY_HEX);
    assert_eq!(sign_license_payload(&sk, &payload()).unwrap(), LICENSE);
}

#[test]
fn github_webhook_hmac_is_stable() {
    let body = br#"{"action":"opened","number":7}"#;
    let sig = "sha256=2e558c86d40bbca9eccb5e9d282e344647b24dcc29dc80d33c98dc0e1ebd0997";
    assert_eq!(compute_github_signature(b"golden-webhook-secret", body), sig);
    assert!(verify_github_signature(b"golden-webhook-secret", body, sig));
}
