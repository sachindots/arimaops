// SPDX-License-Identifier: AGPL-3.0-or-later

//! Values captured from the pre-upgrade RustCrypto stack. Stored data must keep decrypting and
//! verifying byte for byte, so these constants must never be regenerated.

use arima_auth::password::{hash_password, verify_password};
use arima_auth::totp::{totp_code_for_step, verify_totp_stateless};
use arima_auth::VaultKey;

const TOTP_SECRET_B32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

fn golden_vault() -> VaultKey {
    VaultKey::from_bytes(core::array::from_fn(|i| i as u8))
}

#[test]
fn vault_decrypts_ciphertext_written_before_upgrade() {
    let ct = "7773958e4a9bda0929cf915d:11bb256891fdcfd116b40ab2884296c611465c911541e2de72dadc27882ac3fcbbd7c6f886195e3597f0d2b94eae36db";
    let pt = golden_vault().decrypt(b"user:u-golden:totp", ct).unwrap();
    assert_eq!(pt, TOTP_SECRET_B32.as_bytes());
    assert!(golden_vault().decrypt(b"user:u-other:totp", ct).is_err(), "aad still binds");
}

#[test]
fn vault_round_trip_keeps_nonce_hex_envelope() {
    let ct = golden_vault().encrypt(b"aad", b"hello").unwrap();
    let (nonce, body) = ct.split_once(':').unwrap();
    assert_eq!(nonce.len(), 24);
    assert_eq!(body.len(), (5 + 16) * 2, "ciphertext plus 16-byte tag");
    assert_eq!(golden_vault().decrypt(b"aad", &ct).unwrap(), b"hello");
}

#[test]
fn vault_subkey_derivation_is_stable() {
    assert_eq!(
        hex::encode(golden_vault().derive_subkey(b"preview-signing")),
        "75988903f691c4f9ca003b358adbe0e6dce0007758f08897752575be375d4ec8"
    );
}

#[tokio::test]
async fn argon2_verifies_phc_hash_written_before_upgrade() {
    let phc = "$argon2id$v=19$m=19456,t=2,p=1$wWd/eOI/LjK1lWd2d0BTPg$2KmZg7sJuFpIp8c2KPxfKZRuaeELnl4KPIiTm3Hw1Fc";
    assert!(verify_password("golden-password-123".into(), phc.into()).await.unwrap());
    assert!(!verify_password("golden-password-124".into(), phc.into()).await.unwrap());
}

#[tokio::test]
async fn argon2_new_hashes_keep_same_phc_parameters() {
    let phc = hash_password("golden-password-123".into()).await.unwrap();
    assert!(phc.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{phc}");
    assert!(verify_password("golden-password-123".into(), phc).await.unwrap());
}

#[test]
fn totp_matches_rfc6238_sha1_vectors() {
    for (time, code) in [
        (59i64, "287082"),
        (1_111_111_109, "081804"),
        (1_234_567_890, "005924"),
        (2_000_000_000, "279037"),
    ] {
        assert_eq!(totp_code_for_step(TOTP_SECRET_B32, time / 30).unwrap(), code, "t={time}");
        assert_eq!(
            verify_totp_stateless(TOTP_SECRET_B32, code, time).unwrap(),
            Some(time / 30)
        );
    }
}
