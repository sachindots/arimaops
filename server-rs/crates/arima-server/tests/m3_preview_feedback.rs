// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::net::SocketAddr;

use arima_auth::VaultKey;
use arima_core::{
    BoundingBox, ConsoleErrorEntry, ElementSelection, FeedbackRoute, PreviewMode,
};
use arima_db::Db;
use arima_proxy::{
    PreviewProxy, PreviewProxyConfig, RegisteredUpstream, PREVIEW_COOKIE_NAME,
};
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Valid 1x1 PNG byte sequence.
const VALID_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
    0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

async fn spawn_mock_vite_target() -> SocketAddr {
    let app = Router::new().route(
        "/",
        get(|| async {
            let mut resp = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                "<!doctype html><html><body><button id=\"cta\">Ship It</button></body></html>",
            )
                .into_response();
            resp.headers_mut()
                .insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
            resp
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

#[tokio::test]
async fn m3_preview_cookie_isolation_feedback_workspace_sync_symlink_guard_and_purge() {
    let dir = TempDir::new().unwrap();
    let data_root = dir.path().join("arima-v2-home");
    let workspace_alpha = dir.path().join("workspace-alpha");
    fs::create_dir_all(&data_root).unwrap();
    fs::create_dir_all(&workspace_alpha).unwrap();

    let db = Db::open(&data_root.join("arima.db")).unwrap();
    let vault = VaultKey::from_bytes([91u8; 32]);

    let hq_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hq_addr = hq_listener.local_addr().unwrap();

    // Bind preview proxy on a separate port/origin first so we know its exact port.
    let preview_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let preview_addr = preview_probe.local_addr().unwrap();
    drop(preview_probe);

    let cfg = ServerConfig {
        port: hq_addr.port(),
        preview_port: preview_addr.port(),
        bootstrap_token: "m3-boot-token".into(),
        local_origins: vec![
            format!("http://127.0.0.1:{}", hq_addr.port()),
            format!("http://localhost:{}", hq_addr.port()),
        ],
        allowed_origins: vec![],
        preview_origin: Some(format!("http://127.0.0.1:{}", preview_addr.port())),
        trust_proxy: false,
        same_origin: false,
        data_root: Some(data_root.clone()),
    };

    let state = AppState::new(db, vault, cfg);
    state
        .ensure_default_project("Alpha", "alpha", &workspace_alpha.display().to_string())
        .unwrap();

    let preview_handle = PreviewProxy::bind(
        preview_addr,
        state.inner.preview_registry.clone(),
        state.inner.preview_signer.clone(),
        PreviewProxyConfig {
            default_hq_origin: format!("http://127.0.0.1:{}", hq_addr.port()),
            secure_cookies: false,
            trust_proxy: false,
        },
    )
    .await
    .unwrap();

    let app =
        router_with_state(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(hq_listener, app).await;
    });

    // Spawn mock Vite dev server and register as Local target for proj-alpha.
    let vite_addr = spawn_mock_vite_target().await;
    state.inner.preview_registry.register(RegisteredUpstream {
        id: "local-alpha-vite".into(),
        project_id: "proj-alpha".into(),
        project_slug: "alpha".into(),
        agent_id: Some("coder".into()),
        label: "Alpha Vite Dev".into(),
        mode: PreviewMode::Local,
        upstream_host: "127.0.0.1".into(),
        port: vite_addr.port(),
    });

    let hq_origin = format!("http://127.0.0.1:{}", hq_addr.port());
    let preview_origin = format!("http://127.0.0.1:{}", preview_handle.addr.port());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // 1. Create Owner, Operator, and Viewer sessions.
    let login_res = client
        .post(format!("{hq_origin}/api/login"))
        .header("Origin", &hq_origin)
        .json(&json!({ "token": "m3-boot-token" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login_res.status(), StatusCode::OK);
    let owner_cookie = extract_hq_cookie(login_res.headers());

    for (name, pw, role) in [
        ("OwnerM3", "owner-pw-123456", "owner"),
        ("OpM3", "operator-pw-123456", "operator"),
        ("ViewM3", "viewer-pw-123456", "viewer"),
    ] {
        let r = client
            .post(format!("{hq_origin}/api/users"))
            .header("Origin", &hq_origin)
            .header("Cookie", format!("hq_sid={owner_cookie}"))
            .json(&json!({ "name": name, "password": pw, "role": role }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
    }

    let op_cookie = extract_hq_cookie(
        client
            .post(format!("{hq_origin}/api/auth/login"))
            .header("Origin", &hq_origin)
            .json(&json!({ "name": "OpM3", "password": "operator-pw-123456" }))
            .send()
            .await
            .unwrap()
            .headers(),
    );
    let viewer_cookie = extract_hq_cookie(
        client
            .post(format!("{hq_origin}/api/auth/login"))
            .header("Origin", &hq_origin)
            .json(&json!({ "name": "ViewM3", "password": "viewer-pw-123456" }))
            .send()
            .await
            .unwrap()
            .headers(),
    );

    // 2. Viewer CAN list preview targets and mint a read-only preview token.
    let targets_resp: Value = client
        .get(format!("{hq_origin}/api/projects/proj-alpha/preview/targets"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={viewer_cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let targets = targets_resp["targets"].as_array().unwrap();
    assert!(targets.iter().any(|t| t["id"] == "local-alpha-vite" && t["status"] == "live"));

    let tok_resp = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/preview/token"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={viewer_cookie}"))
        .json(&json!({ "targetId": "local-alpha-vite" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tok_resp.status(), StatusCode::OK);
    let tok_json: Value = tok_resp.json().await.unwrap();
    let exchange_url = tok_json["previewUrl"].as_str().unwrap().to_owned();
    assert!(exchange_url.starts_with(&preview_origin));

    // 3. Exchange token on isolated preview proxy -> receives `arima_preview_sid` ONLY,
    //    and verifies cross-origin isolation between Preview (:7421) and HQ (:7420).
    let exch = client.get(&exchange_url).send().await.unwrap();
    assert_eq!(exch.status(), StatusCode::FOUND);
    let set_cookie = exch
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(set_cookie.starts_with(&format!("{PREVIEW_COOKIE_NAME}=")));
    let preview_cookie_kv = set_cookie.split(';').next().unwrap().to_owned();

    // Preview cookie is NEVER accepted by HQ `/api/auth/me`.
    let hq_me_with_preview_ck = client
        .get(format!("{hq_origin}/api/auth/me"))
        .header("Cookie", &preview_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(hq_me_with_preview_ck.status(), StatusCode::UNAUTHORIZED);

    // Requests from Preview Origin (`:7421`) to HQ mutating `/api/*` are blocked (403 FORBIDDEN).
    let preview_calling_hq = client
        .post(format!("{hq_origin}/api/projects"))
        .header("Origin", &preview_origin)
        .header("Cookie", format!("hq_sid={owner_cookie}"))
        .json(&json!({ "name": "Hijack", "slug": "hijack" }))
        .send()
        .await
        .unwrap();
    assert_eq!(preview_calling_hq.status(), StatusCode::FORBIDDEN);

    // Fetch live HTML via Preview Proxy -> X-Frame-Options stripped, strict origin-locked ArimaBridge injected.
    let preview_html_res = client
        .get(format!("{preview_origin}/"))
        .header("Cookie", &preview_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(preview_html_res.status(), StatusCode::OK);
    assert!(preview_html_res.headers().get("x-frame-options").is_none());
    let html_body = preview_html_res.text().await.unwrap();
    assert!(html_body.contains("data-arima-bridge=\"1\""));
    assert!(html_body.contains(&format!("const HQ_ORIGIN = \"{hq_origin}\";")));

    // 4. Snapshot endpoint returns valid contract (`imageDataUrl`, `fallback`).
    let snap_res = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/preview/snapshot"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .json(&json!({
            "targetId": "local-alpha-vite",
            "pageUrl": "/",
            "viewportWidth": 1280,
            "viewportHeight": 800
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(snap_res.status(), StatusCode::OK);
    let snap_json: Value = snap_res.json().await.unwrap();
    assert!(snap_json.get("fallback").and_then(Value::as_bool).is_some());
    assert!(snap_json.get("imageDataUrl").and_then(Value::as_str).is_some());

    // 5. Connect WS client to verify `feedback-created` broadcast.
    let mut ws_req = format!("ws://{hq_addr}/ws").into_client_request().unwrap();
    ws_req
        .headers_mut()
        .insert("Cookie", format!("hq_sid={op_cookie}").parse().unwrap());
    ws_req.headers_mut().insert("Origin", hq_origin.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_req).await.unwrap();
    let _initial_snap = ws.next().await.unwrap().unwrap();

    let valid_png_data_url = format!("data:image/png;base64,{}", BASE64_STD.encode(VALID_PNG));

    // Viewer MUST be blocked from submitting feedback (403 FORBIDDEN).
    let viewer_fb = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/feedback"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={viewer_cookie}"))
        .json(&json!({
            "targetId": "local-alpha-vite",
            "sourceKind": "preview",
            "pageUrl": "/",
            "viewportWidth": 1440,
            "viewportHeight": 900,
            "note": "Viewer attempt",
            "selection": null,
            "consoleErrors": [],
            "route": { "kind": "send-to-chat", "toAgentId": "coder", "messageId": null },
            "imageDataUrl": valid_png_data_url
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(viewer_fb.status(), StatusCode::FORBIDDEN);

    // Invalid (non-PNG) image data URL MUST be rejected (400 BAD REQUEST).
    let bad_png_fb = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/feedback"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .json(&json!({
            "targetId": "local-alpha-vite",
            "sourceKind": "preview",
            "pageUrl": "/",
            "viewportWidth": 1440,
            "viewportHeight": 900,
            "note": "Bad image",
            "selection": null,
            "consoleErrors": [],
            "route": { "kind": "send-to-chat", "toAgentId": "coder", "messageId": null },
            "imageDataUrl": "data:image/png;base64,bm90LWEtcG5n"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_png_fb.status(), StatusCode::BAD_REQUEST);

    // 6. Operator submits valid PNG feedback routed to `CreateTask`.
    let sel = ElementSelection {
        css_selector: "#cta".into(),
        tag_name: "button".into(),
        aria_role: Some("button".into()),
        component_hint: Some("HeroCta".into()),
        text_snippet: "Ship It".into(),
        outer_html_snippet: "<button id=\"cta\">Ship It</button>".into(),
        bbox: BoundingBox {
            x: 120.0,
            y: 80.0,
            width: 140.0,
            height: 40.0,
        },
    };
    let errs = vec![ConsoleErrorEntry {
        level: "error".into(),
        message: "TypeError: cannot read property".into(),
        source: Some("app.tsx:42".into()),
        at: "2026-11-21T00:00:00Z".into(),
    }];

    let task_fb_res = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/feedback"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .json(&json!({
            "targetId": "local-alpha-vite",
            "sourceKind": "preview",
            "pageUrl": "/dashboard",
            "viewportWidth": 1440,
            "viewportHeight": 900,
            "note": "Align CTA button padding on tablet",
            "selection": sel,
            "consoleErrors": errs,
            "route": FeedbackRoute::CreateTask {
                board_id: Some("B1".into()),
                task_id: None,
                assign_to_agent_id: Some("coder".into()),
            },
            "imageDataUrl": valid_png_data_url
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(task_fb_res.status(), StatusCode::OK);
    let task_fb_json: Value = task_fb_res.json().await.unwrap();
    let fb_id = task_fb_json["feedback"]["id"].as_str().unwrap().to_owned();
    let created_task_id = task_fb_json["feedback"]["route"]["taskId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Verify files written to BOTH `<data_root>/feedback/alpha/<id>/` AND `<workspace>/.arima/feedback/<id>/`!
    let store_png = data_root
        .join("feedback")
        .join("alpha")
        .join(&fb_id)
        .join("annotated.png");
    let store_ctx = data_root
        .join("feedback")
        .join("alpha")
        .join(&fb_id)
        .join("context.json");
    let ws_png = workspace_alpha
        .join(".arima")
        .join("feedback")
        .join(&fb_id)
        .join("annotated.png");
    let ws_ctx = workspace_alpha
        .join(".arima")
        .join("feedback")
        .join(&fb_id)
        .join("context.json");

    assert_eq!(fs::read(&store_png).unwrap(), VALID_PNG);
    assert_eq!(fs::read(&ws_png).unwrap(), VALID_PNG);
    assert!(fs::read_to_string(&store_ctx)
        .unwrap()
        .contains("Align CTA button padding on tablet"));
    assert!(fs::read_to_string(&ws_ctx)
        .unwrap()
        .contains("#cta"));

    // Verify GET /feedback and GET /feedback/{id}/image return the stored record & PNG bytes.
    let list_fb: Value = client
        .get(format!("{hq_origin}/api/projects/proj-alpha/feedback"))
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list_fb["items"].as_array().unwrap().len(), 1);

    let img_res = client
        .get(format!(
            "{hq_origin}/api/projects/proj-alpha/feedback/{fb_id}/image"
        ))
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(img_res.status(), StatusCode::OK);
    assert_eq!(img_res.headers().get("content-type").unwrap(), "image/png");
    assert_eq!(img_res.bytes().await.unwrap().as_ref(), VALID_PNG);

    // Verify Board task was created in SQLite.
    let task_exists: i64 = state
        .inner
        .db
        .read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id = 'proj-alpha' AND id = ?1",
                [&created_task_id],
                |r| r.get(0),
            )
            .map_err(arima_db::DbError::from)
        })
        .unwrap();
    assert_eq!(task_exists, 1);

    // Verify WS broadcast received `feedback-created`.
    let ws_frame = ws.next().await.unwrap().unwrap();
    let ws_ev: Value = serde_json::from_str(ws_frame.to_text().unwrap()).unwrap();
    assert_eq!(ws_ev["type"], "feedback-created");
    assert_eq!(ws_ev["feedback"]["id"], fb_id);

    // 7. Submit feedback routed to `SendToChat` -> enqueues `OutboxMessageKind::VisualFeedback` into `agent_outbox`.
    let chat_fb_res = client
        .post(format!("{hq_origin}/api/projects/proj-alpha/feedback"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={op_cookie}"))
        .json(&json!({
            "targetId": "local-alpha-vite",
            "sourceKind": "evidence",
            "pageUrl": "/pr/42",
            "viewportWidth": 900,
            "viewportHeight": 1024,
            "note": "Check PR evidence overlap",
            "selection": null,
            "consoleErrors": [],
            "route": FeedbackRoute::SendToChat {
                to_agent_id: "coder".into(),
                message_id: None,
            },
            "imageDataUrl": valid_png_data_url
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat_fb_res.status(), StatusCode::OK);
    assert_eq!(
        state.inner.outbox.pending_count("proj-alpha", "coder").unwrap(),
        1
    );

    // 8. Symlink-escape guard: project workspace with `.arima/feedback` symlink pointing outside MUST be blocked!
    #[cfg(unix)]
    {
        let outside_dir = dir.path().join("outside-target");
        let sym_workspace = dir.path().join("workspace-sym");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::create_dir_all(sym_workspace.join(".arima")).unwrap();
        std::os::unix::fs::symlink(&outside_dir, sym_workspace.join(".arima").join("feedback"))
            .unwrap();

        let create_sym = client
            .post(format!("{hq_origin}/api/projects"))
            .header("Origin", &hq_origin)
            .header("Cookie", format!("hq_sid={owner_cookie}"))
            .json(&json!({
                "name": "SymProject",
                "slug": "symproj",
                "rootPath": sym_workspace.display().to_string()
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(create_sym.status(), StatusCode::OK);

        let sym_fb = client
            .post(format!("{hq_origin}/api/projects/proj-symproj/feedback"))
            .header("Origin", &hq_origin)
            .header("Cookie", format!("hq_sid={owner_cookie}"))
            .json(&json!({
                "targetId": null,
                "sourceKind": "preview",
                "pageUrl": "/",
                "viewportWidth": 1440,
                "viewportHeight": 900,
                "note": "Attempt escape",
                "selection": null,
                "consoleErrors": [],
                "route": { "kind": "send-to-chat", "toAgentId": "coder", "messageId": null },
                "imageDataUrl": valid_png_data_url
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(sym_fb.status(), StatusCode::BAD_REQUEST);
        assert!(
            fs::read_dir(&outside_dir).unwrap().next().is_none(),
            "symlink target outside workspace must stay completely empty"
        );
    }

    // 9. `forget_project` (DELETE /api/projects/proj-alpha) cleans BOTH SQLite `visual_feedback` AND `<data_root>/feedback/alpha/`.
    let del_res = client
        .delete(format!("{hq_origin}/api/projects/proj-alpha"))
        .header("Origin", &hq_origin)
        .header("Cookie", format!("hq_sid={owner_cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del_res.status(), StatusCode::OK);
    assert!(!data_root.join("feedback").join("alpha").exists());
    assert!(state
        .inner
        .feedback
        .list_by_project("proj-alpha")
        .unwrap()
        .is_empty());

    preview_handle.shutdown();
}

fn extract_hq_cookie(headers: &reqwest::header::HeaderMap) -> String {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|s| s.split(';').next()?.strip_prefix("hq_sid="))
        .expect("hq_sid cookie")
        .to_owned()
}

#[tokio::test]
async fn cloud_https_wildcard_subdomain_preview_secure_cookies_and_passkeys_on_public_origin() {
    let dir = TempDir::new().unwrap();
    let db = Db::open(&dir.path().join("arima.db")).unwrap();
    let vault = VaultKey::from_bytes([19u8; 32]);

    let hq_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hq_addr = hq_listener.local_addr().unwrap();

    let cfg = ServerConfig {
        port: hq_addr.port(),
        preview_port: hq_addr.port() + 1,
        bootstrap_token: "cloud-boot-tok".into(),
        local_origins: vec![format!("http://127.0.0.1:{}", hq_addr.port())],
        allowed_origins: vec!["https://hq.example.com".into()],
        preview_origin: None,
        trust_proxy: true,
        same_origin: false,
        data_root: Some(dir.path().to_path_buf()),
    };

    let state = AppState::new(db, vault, cfg);
    state.configure_cloud_proxy(
        Some("https://hq.example.com".into()),
        Some("example.com".into()),
    );
    state
        .ensure_default_project("Alpha", "alpha", "/tmp/alpha")
        .unwrap();

    let vite_addr = spawn_mock_vite_target().await;
    state.inner.preview_registry.register(RegisteredUpstream {
        id: "local-alpha-vite".into(),
        project_id: "proj-alpha".into(),
        project_slug: "alpha".into(),
        agent_id: None,
        label: "Alpha App".into(),
        mode: PreviewMode::Local,
        upstream_host: "127.0.0.1".into(),
        port: vite_addr.port(),
    });

    let app =
        router_with_state(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(hq_listener, app).await;
    });

    let base = format!("http://{hq_addr}");
    let client = reqwest::Client::new();

    // 1. Login via HTTPS reverse proxy sets `; Secure` on `hq_sid` and includes `https://*.example.com` in CSP frame-src.
    let login = client
        .post(format!("{base}/api/login"))
        .header("Host", "hq.example.com")
        .header("Origin", "https://hq.example.com")
        .header("X-Forwarded-Proto", "https")
        .json(&json!({ "token": "cloud-boot-tok" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let csp = login
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        csp.contains("https://*.example.com"),
        "CSP frame-src must allow wildcard preview subdomain: {csp}"
    );
    let set_cookie = login
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        set_cookie.contains("; Secure"),
        "hq_sid must carry Secure attribute under X-Forwarded-Proto: https: {set_cookie}"
    );
    let hq_cookie = extract_hq_cookie(login.headers());

    // 2. Foreign origin is still strictly rejected (403 FORBIDDEN).
    let bad_orig = client
        .post(format!("{base}/api/projects/proj-alpha/preview/token"))
        .header("Host", "hq.example.com")
        .header("Origin", "https://evil.example")
        .header("X-Forwarded-Proto", "https")
        .header("Cookie", format!("hq_sid={hq_cookie}"))
        .json(&json!({ "targetId": "local-alpha-vite" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_orig.status(), StatusCode::FORBIDDEN);

    // 3. Passkeys are enabled seamlessly on `HQ_PUBLIC_ORIGIN` (`https://hq.example.com`).
    let me_json: Value = client
        .get(format!("{base}/api/auth/me"))
        .header("Host", "hq.example.com")
        .header("Origin", "https://hq.example.com")
        .header("X-Forwarded-Proto", "https")
        .header("Cookie", format!("hq_sid={hq_cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me_json["passkeysAvailable"], true);

    // 4. Preview targets & token generation emit `https://preview-alpha.example.com` subdomain URLs!
    let targets: Value = client
        .get(format!("{base}/api/projects/proj-alpha/preview/targets"))
        .header("Host", "hq.example.com")
        .header("Origin", "https://hq.example.com")
        .header("X-Forwarded-Proto", "https")
        .header("Cookie", format!("hq_sid={hq_cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        targets["targets"][0]["previewUrl"],
        "https://preview-alpha.example.com/"
    );

    let tok_res: Value = client
        .post(format!("{base}/api/projects/proj-alpha/preview/token"))
        .header("Host", "hq.example.com")
        .header("Origin", "https://hq.example.com")
        .header("X-Forwarded-Proto", "https")
        .header("Cookie", format!("hq_sid={hq_cookie}"))
        .json(&json!({ "targetId": "local-alpha-vite" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let preview_url = tok_res["previewUrl"].as_str().unwrap();
    assert!(
        preview_url.starts_with("https://preview-alpha.example.com/__arima_preview/exchange?token="),
        "expected wildcard HTTPS subdomain exchange URL, got {preview_url}"
    );
    let token = tok_res["token"].as_str().unwrap();
    let claims = state.inner.preview_signer.verify_token(token, None).unwrap();
    assert_eq!(claims.hq_origin, "https://hq.example.com");
}
