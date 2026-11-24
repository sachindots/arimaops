// SPDX-License-Identifier: AGPL-3.0-or-later

//! Value captured from the pre-upgrade RustCrypto stack: a preview cookie signed before the
//! upgrade must keep verifying byte for byte. Never regenerate it.

use arima_proxy::preview::{PreviewClaims, PreviewTokenSigner};

const COOKIE: &str = "eyJwcm9qZWN0SWQiOiJwLWdvbGRlbiIsInRhcmdldElkIjoid2ViIiwiaHFPcmlnaW4iOiJodHRwOi8vMTI3LjAuMC4xOjc0MjAiLCJleHAiOjQxMDI0NDQ4MDAsIm5vbmNlIjoiMDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmYifQ.6902c86d875b96f894c7a3133933ea85b64010baf2e082f78abf925d82f370d2";

#[test]
fn preview_cookie_hmac_is_stable() {
    let signer = PreviewTokenSigner::from_master_bytes(&[5u8; 32]);
    let claims = PreviewClaims {
        project_id: "p-golden".into(),
        target_id: "web".into(),
        hq_origin: "http://127.0.0.1:7420".into(),
        exp: 4_102_444_800,
        nonce: "00112233445566778899aabbccddeeff".into(),
    };
    assert_eq!(signer.sign_cookie(&claims), COOKIE);
    assert_eq!(signer.verify_cookie(COOKIE, Some(1_800_000_000)).unwrap(), claims);
}
