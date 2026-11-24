// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::path::Path;

use arima_auth::{PasskeyService, PublicKeyCredential, RegisterPublicKeyCredential};
use arima_db::{Db, DbError};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use crypto_glue::ecdsa_p256::{EcdsaP256DerSignature, EcdsaP256SigningKey};
use crypto_glue::rsa::{RS256PrivateKey, RS256SigningKey};
use crypto_glue::traits::{Pkcs8DecodePrivateKey, SignatureEncoding, Signer};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const LEGACY_USER_ID: &str = "11111111-2222-3333-4444-555555555555";
const TEST_ORIGIN: &str = "http://localhost:7496";
const TEST_RP_ID: &str = "localhost";
const TEST_CRED_ID: [u8; 32] = [0xAA; 32];
const TEST_P256_PRIV_HEX: &str = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn cbor_bytes(out: &mut Vec<u8>, data: &[u8]) {
    let len = data.len();
    if len < 24 {
        out.push(0x40 | (len as u8));
    } else if len < 256 {
        out.push(0x58);
        out.push(len as u8);
    } else {
        out.push(0x59);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    }
    out.extend_from_slice(data);
}

fn test_signing_key() -> EcdsaP256SigningKey {
    let raw = hex::decode(TEST_P256_PRIV_HEX).unwrap();
    EcdsaP256SigningKey::from_slice(&raw).unwrap()
}

fn build_es256_assertion(
    signing_key: &EcdsaP256SigningKey,
    cred_id: &[u8],
    challenge_b64: &str,
    sign_count: u32,
) -> PublicKeyCredential {
    let sign = |payload: &[u8]| {
        let sig: EcdsaP256DerSignature = signing_key.sign(payload);
        sig.to_vec()
    };
    // UP | UV | BE | BS
    build_assertion(&sign, 0x1d, cred_id, challenge_b64, sign_count)
}

fn build_assertion(
    sign: &dyn Fn(&[u8]) -> Vec<u8>,
    flags: u8,
    cred_id: &[u8],
    challenge_b64: &str,
    sign_count: u32,
) -> PublicKeyCredential {
    let client_data_json = format!(
        r#"{{"type":"webauthn.get","challenge":"{challenge_b64}","origin":"{TEST_ORIGIN}","crossOrigin":false}}"#
    );
    let client_data_hash = Sha256::digest(client_data_json.as_bytes());

    let mut auth_data = Vec::with_capacity(37);
    auth_data.extend_from_slice(&Sha256::digest(TEST_RP_ID.as_bytes()));
    auth_data.push(flags);
    auth_data.extend_from_slice(&sign_count.to_be_bytes());

    let mut signed_payload = Vec::with_capacity(auth_data.len() + client_data_hash.len());
    signed_payload.extend_from_slice(&auth_data);
    signed_payload.extend_from_slice(&client_data_hash);

    let sig = sign(&signed_payload);
    let cred_val = json!({
        "id": b64url(cred_id),
        "rawId": b64url(cred_id),
        "type": "public-key",
        "response": {
            "authenticatorData": b64url(&auth_data),
            "clientDataJSON": b64url(client_data_json.as_bytes()),
            "signature": b64url(&sig),
            "userHandle": null,
        }
    });
    serde_json::from_value(cred_val).unwrap()
}

#[test]
fn passkey_registered_with_webauthn_rs_05_authenticates_with_06() {
    let fixture_db = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../arima-db/tests/fixtures/pre_upgrade_v032.db");
    assert!(fixture_db.is_file());

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("arima.db");
    fs::copy(&fixture_db, &db_path).unwrap();

    let db = Db::open(&db_path).unwrap();
    let svc = PasskeyService::new(db.clone());

    let listed = svc.list_passkeys(LEGACY_USER_ID).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label, "Pre-upgrade Key");
    assert!(listed[0].last_used_at.is_none());

    let start = svc
        .start_authentication(Some(LEGACY_USER_ID), TEST_ORIGIN)
        .unwrap();
    let opts_val = serde_json::to_value(&start.options).unwrap();
    let challenge_b64 = opts_val["publicKey"]["challenge"].as_str().unwrap();

    let signing_key = test_signing_key();
    let assertion = build_es256_assertion(&signing_key, &TEST_CRED_ID, challenge_b64, 2);

    let authed_user = svc
        .finish_authentication(&start.challenge_id, assertion)
        .unwrap();
    assert_eq!(authed_user, LEGACY_USER_ID);

    let listed_after = svc.list_passkeys(LEGACY_USER_ID).unwrap();
    assert!(listed_after[0].last_used_at.is_some());
    let updated_json: String = db
        .read(|conn| {
            conn.query_row(
                "SELECT credential_json FROM passkeys WHERE user_id = ?1",
                [LEGACY_USER_ID],
                |r| r.get(0),
            )
            .map_err(DbError::from)
        })
        .unwrap();
    let parsed_json: serde_json::Value = serde_json::from_str(&updated_json).unwrap();
    assert_eq!(parsed_json["cred"]["counter"], 2);

    let start2 = svc
        .start_authentication(Some(LEGACY_USER_ID), TEST_ORIGIN)
        .unwrap();
    let challenge2 = serde_json::to_value(&start2.options).unwrap()["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let replay = build_es256_assertion(&signing_key, &TEST_CRED_ID, &challenge2, 2);
    assert!(svc
        .finish_authentication(&start2.challenge_id, replay)
        .is_err());
}

#[test]
fn standalone_webauthn_rs_05_passkey_json_round_trips_and_06_registration_works() {
    let fixture_json_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/passkey_v05_es256.json");
    let raw_v05 = fs::read_to_string(&fixture_json_path).unwrap();
    // The fixture is byte-identical to what webauthn-rs 0.5.5 stored on registration; 0.6 must
    // read and write the same JSON so stored passkeys survive the upgrade and a rollback.
    let reparsed: webauthn_rs::prelude::Passkey = serde_json::from_str(&raw_v05).unwrap();
    assert_eq!(serde_json::to_string(&reparsed).unwrap(), raw_v05.trim());

    // user_id = None takes the username-less path through load_all_passkeys.
    let db = Db::open_in_memory().unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO users (id, name, password_hash, role, created_at)
             VALUES (?1, 'sachin', 'h', 'owner', 1)",
            [LEGACY_USER_ID],
        )?;
        conn.execute(
            "INSERT INTO passkeys (id, user_id, credential_json, label, created_at, last_used_at)
             VALUES ('pk-v05', ?1, ?2, 'v0.5 JSON', 1, NULL)",
            rusqlite::params![LEGACY_USER_ID, raw_v05],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let svc = PasskeyService::new(db.clone());
    let start = svc.start_authentication(None, TEST_ORIGIN).unwrap();
    let challenge_b64 = serde_json::to_value(&start.options).unwrap()["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let signing_key = test_signing_key();
    let assertion = build_es256_assertion(&signing_key, &TEST_CRED_ID, &challenge_b64, 5);
    let authed_user = svc
        .finish_authentication(&start.challenge_id, assertion)
        .unwrap();
    assert_eq!(authed_user, LEGACY_USER_ID);

    let reg_start = svc
        .start_registration(LEGACY_USER_ID, "sachin", TEST_ORIGIN, "v0.6 Key".into())
        .unwrap();
    let reg_challenge = serde_json::to_value(&reg_start.options).unwrap()["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();

    let new_priv = EcdsaP256SigningKey::from_slice(&[0x42u8; 32]).unwrap();
    let pub_point = new_priv.verifying_key().to_sec1_point(false);
    let x = pub_point.x().unwrap();
    let y = pub_point.y().unwrap();
    let new_cred_id = [0xBBu8; 32];

    let mut cose = Vec::new();
    cose.push(0xa5);
    cose.extend_from_slice(&[0x01, 0x02]);
    cose.extend_from_slice(&[0x03, 0x26]);
    cose.extend_from_slice(&[0x20, 0x01]);
    cose.push(0x21);
    cbor_bytes(&mut cose, x.as_slice());
    cose.push(0x22);
    cbor_bytes(&mut cose, y.as_slice());

    let mut auth_data = Vec::new();
    auth_data.extend_from_slice(&Sha256::digest(TEST_RP_ID.as_bytes()));
    auth_data.push(0x5d);
    auth_data.extend_from_slice(&1u32.to_be_bytes());
    auth_data.extend_from_slice(&[0u8; 16]);
    auth_data.extend_from_slice(&(new_cred_id.len() as u16).to_be_bytes());
    auth_data.extend_from_slice(&new_cred_id);
    auth_data.extend_from_slice(&cose);

    let mut att_obj = Vec::new();
    att_obj.push(0xa3);
    att_obj.extend_from_slice(b"\x63fmt\x64none");
    att_obj.extend_from_slice(b"\x67attStmt\xa0");
    att_obj.extend_from_slice(b"\x68authData");
    cbor_bytes(&mut att_obj, &auth_data);

    let client_data_json = format!(
        r#"{{"type":"webauthn.create","challenge":"{reg_challenge}","origin":"{TEST_ORIGIN}","crossOrigin":false}}"#
    );
    let reg_cred: RegisterPublicKeyCredential = serde_json::from_value(json!({
        "id": b64url(&new_cred_id),
        "rawId": b64url(&new_cred_id),
        "type": "public-key",
        "response": {
            "attestationObject": b64url(&att_obj),
            "clientDataJSON": b64url(client_data_json.as_bytes()),
        }
    }))
    .unwrap();
    let info = svc
        .finish_registration(LEGACY_USER_ID, &reg_start.challenge_id, reg_cred)
        .unwrap();
    assert_eq!(info.label, "v0.6 Key");

    let auth_start = svc
        .start_authentication(Some(LEGACY_USER_ID), TEST_ORIGIN)
        .unwrap();
    let auth_challenge = serde_json::to_value(&auth_start.options).unwrap()["publicKey"]
        ["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let new_assertion = build_es256_assertion(&new_priv, &new_cred_id, &auth_challenge, 2);
    let uid = svc
        .finish_authentication(&auth_start.challenge_id, new_assertion)
        .unwrap();
    assert_eq!(uid, LEGACY_USER_ID);
}

#[test]
fn rs256_passkey_registered_with_webauthn_rs_05_authenticates_with_06() {
    // OpenSSL verified RS256 in 0.5; 0.6 verifies with RustCrypto. Windows Hello keys are RS256.
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let raw_v05 = fs::read_to_string(fixtures.join("passkey_v05_rs256.json")).unwrap();
    let reparsed: webauthn_rs::prelude::Passkey = serde_json::from_str(&raw_v05).unwrap();
    assert_eq!(serde_json::to_string(&reparsed).unwrap(), raw_v05.trim());

    let db = Db::open_in_memory().unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO users (id, name, password_hash, role, created_at)
             VALUES (?1, 'sachin', 'h', 'owner', 1)",
            [LEGACY_USER_ID],
        )?;
        conn.execute(
            "INSERT INTO passkeys (id, user_id, credential_json, label, created_at, last_used_at)
             VALUES ('pk-rs256', ?1, ?2, 'RS256', 1, NULL)",
            rusqlite::params![LEGACY_USER_ID, raw_v05],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let pem = fs::read_to_string(fixtures.join("rs256_test_key.pem")).unwrap();
    let signing_key = RS256SigningKey::new(RS256PrivateKey::from_pkcs8_pem(&pem).unwrap());
    let sign = |payload: &[u8]| signing_key.sign(payload).to_vec();
    let cred_id = [0xCCu8; 32];

    let svc = PasskeyService::new(db);
    let start = svc
        .start_authentication(Some(LEGACY_USER_ID), TEST_ORIGIN)
        .unwrap();
    let challenge = serde_json::to_value(&start.options).unwrap()["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    // UP | UV, counter 0 as Windows Hello sends it.
    let assertion = build_assertion(&sign, 0x05, &cred_id, &challenge, 0);
    assert_eq!(
        svc.finish_authentication(&start.challenge_id, assertion)
            .unwrap(),
        LEGACY_USER_ID
    );

    let start2 = svc
        .start_authentication(Some(LEGACY_USER_ID), TEST_ORIGIN)
        .unwrap();
    let challenge2 = serde_json::to_value(&start2.options).unwrap()["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut forged = build_assertion(&sign, 0x05, &cred_id, &challenge2, 0);
    forged.response.signature = vec![0u8; 256];
    assert!(svc
        .finish_authentication(&start2.challenge_id, forged)
        .is_err());
}
