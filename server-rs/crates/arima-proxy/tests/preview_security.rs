// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use arima_core::PreviewMode;
use arima_proxy::{
    ContainerIpRegistry, PreviewProxy, PreviewProxyConfig, PreviewRegistry, PreviewTokenSigner,
    RegisteredUpstream, PREVIEW_COOKIE_NAME,
};
use axum::extract::ws::{Message as AxumWsMsg, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungMsg;

async fn spawn_mock_dev_server() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let seen_cookies = Arc::new(Mutex::new(Vec::<String>::new()));
    let ck_ref = seen_cookies.clone();

    let app = Router::new()
        .route(
            "/app",
            get(move |headers: HeaderMap| {
                let ck_ref = ck_ref.clone();
                async move {
                    let ck = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned();
                    ck_ref.lock().unwrap().push(ck);

                    let mut resp = (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                        "<!doctype html><html><body><h1>Live App</h1></body></html>",
                    )
                        .into_response();
                    // Upstream tries to block framing; PreviewProxy must strip these.
                    resp.headers_mut()
                        .insert("x-frame-options", HeaderValue::from_static("DENY"));
                    resp.headers_mut().insert(
                        "content-security-policy",
                        HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'"),
                    );
                    resp
                }
            }),
        )
        .route(
            "/api/data.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    r#"{"ok":true,"raw":1}"#,
                )
            }),
        )
        .route(
            "/__vite_hmr",
            get(|ws: WebSocketUpgrade| async move {
                ws.protocols(["vite-hmr"]).on_upgrade(|mut sock| async move {
                    while let Some(Ok(msg)) = sock.next().await {
                        if let AxumWsMsg::Text(t) = msg {
                            let _ = sock.send(AxumWsMsg::Text(format!("hmr-echo:{t}").into())).await;
                        }
                    }
                })
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, seen_cookies)
}

#[tokio::test]
async fn preview_proxy_enforces_cookie_isolation_strips_framing_headers_injects_bridge_and_proxies_hmr() {
    let (upstream_addr, seen_cookies) = spawn_mock_dev_server().await;

    let registry = PreviewRegistry::new(ContainerIpRegistry::new());
    registry.register(RegisteredUpstream {
        id: "local-alpha-dev".into(),
        project_id: "proj-alpha".into(),
        project_slug: "alpha".into(),
        agent_id: None,
        label: "Alpha Dev".into(),
        mode: PreviewMode::Local,
        upstream_host: "127.0.0.1".into(),
        port: upstream_addr.port(),
    });

    let signer = PreviewTokenSigner::from_master_bytes(b"0123456789abcdef0123456789abcdef");
    let handle = PreviewProxy::bind(
        "127.0.0.1:0".parse().unwrap(),
        registry.clone(),
        signer.clone(),
        PreviewProxyConfig {
            default_hq_origin: "http://localhost:7420".into(),
            secure_cookies: false,
            trust_proxy: true,
        },
    )
    .await
    .unwrap();
    let proxy_addr = handle.addr;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // 1. Unauthenticated request and request carrying ONLY HQ's `hq_sid` MUST get 401!
    let r_unauth = client
        .get(format!("http://{proxy_addr}/app"))
        .send()
        .await
        .unwrap();
    assert_eq!(r_unauth.status(), StatusCode::UNAUTHORIZED);

    let r_hq_cookie_only = client
        .get(format!("http://{proxy_addr}/app"))
        .header("Cookie", "hq_sid=super-secret-hq-session")
        .send()
        .await
        .unwrap();
    assert_eq!(
        r_hq_cookie_only.status(),
        StatusCode::UNAUTHORIZED,
        "preview proxy must NEVER accept hq_sid for auth"
    );

    // 2. Forged token & expired token rejected on exchange endpoint.
    let r_forged = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/exchange?token=forged.0000&next=/app"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r_forged.status(), StatusCode::UNAUTHORIZED);

    let (valid_token, _) = signer.sign_token(
        "proj-alpha",
        "local-alpha-dev",
        "http://localhost:7420",
        Some(600),
    );
    // Token cannot be reused directly as preview cookie (domain-separated keys).
    let r_token_as_cookie = client
        .get(format!("http://{proxy_addr}/app"))
        .header("Cookie", format!("{PREVIEW_COOKIE_NAME}={valid_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r_token_as_cookie.status(), StatusCode::UNAUTHORIZED);

    // 3. Valid token exchange sets `arima_preview_sid` (HttpOnly; SameSite=Lax; Path=/) and blocks open redirect.
    let r_open_redir = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/exchange?token={valid_token}&next=//evil.example"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r_open_redir.status(), StatusCode::FOUND);
    assert_eq!(r_open_redir.headers().get("location").unwrap(), "/");

    let r_exch = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/exchange?token={valid_token}&next=/app"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r_exch.status(), StatusCode::FOUND);
    assert_eq!(r_exch.headers().get("location").unwrap(), "/app");
    let set_cookie = r_exch
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(set_cookie.starts_with(&format!("{PREVIEW_COOKIE_NAME}=")));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(!set_cookie.contains("hq_sid"));
    let preview_cookie_kv = set_cookie.split(';').next().unwrap().to_owned();

    // 4. Proxied HTML request strips `hq_sid` before reaching upstream, strips X-Frame-Options,
    //    rewrites CSP `frame-ancestors`, and injects origin-locked `ArimaBridge`.
    let r_html = client
        .get(format!("http://{proxy_addr}/app"))
        .header(
            "Cookie",
            format!("hq_sid=secret-hq-cookie; {preview_cookie_kv}; app_pref=dark"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(r_html.status(), StatusCode::OK);
    assert!(
        r_html.headers().get("x-frame-options").is_none(),
        "X-Frame-Options must be stripped"
    );
    let csp = r_html
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(!csp.contains("frame-ancestors 'none'"));
    assert!(csp.contains("frame-ancestors 'self' http://localhost:7420"));

    let html_body = r_html.text().await.unwrap();
    assert!(html_body.contains("<h1>Live App</h1>"));
    assert!(html_body.contains("data-arima-bridge=\"1\""));
    assert!(html_body.contains("const HQ_ORIGIN = \"http://localhost:7420\";"));
    assert!(!html_body.contains("postMessage(payload, \"*\")"));

    // Verify upstream NEVER saw `hq_sid` or `arima_preview_sid`, while preserving app's own `app_pref=dark`!
    let upstream_cookies = seen_cookies.lock().unwrap().clone();
    assert_eq!(upstream_cookies.len(), 1);
    assert!(!upstream_cookies[0].contains("hq_sid"));
    assert!(!upstream_cookies[0].contains(PREVIEW_COOKIE_NAME));
    assert!(upstream_cookies[0].contains("app_pref=dark"));

    // 5. Non-HTML responses are NOT injected with ArimaBridge.
    let r_json = client
        .get(format!("http://{proxy_addr}/api/data.json"))
        .header("Cookie", &preview_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(r_json.status(), StatusCode::OK);
    let json_text = r_json.text().await.unwrap();
    assert_eq!(json_text, r#"{"ok":true,"raw":1}"#);

    // 6. Subdomain routing (`Host: preview-alpha.localhost`) resolves target cleanly,
    //    AND cross-project subdomain (`Host: preview-beta.localhost`) is strictly rejected (403)!
    let r_sub = client
        .get(format!("http://{proxy_addr}/api/data.json"))
        .header("Host", "preview-alpha.localhost")
        .header("Cookie", &preview_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(r_sub.status(), StatusCode::OK);

    let r_cross_sub = client
        .get(format!("http://{proxy_addr}/api/data.json"))
        .header("Host", "preview-beta.localhost")
        .header("Cookie", &preview_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r_cross_sub.status(),
        StatusCode::FORBIDDEN,
        "preview cookie for alpha must never work on preview-beta subdomain"
    );

    // 6b. Behind HTTPS reverse proxy (`X-Forwarded-Proto: https` + HTTPS `hq_origin`),
    //     `/exchange` sets `; Secure` on `arima_preview_sid` and locks `frame-ancestors` + `ArimaBridge` to HTTPS HQ origin.
    let (https_tok, _) = signer.sign_token(
        "proj-alpha",
        "local-alpha-dev",
        "https://hq.example.com",
        Some(600),
    );
    let r_https_exch = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/exchange?token={https_tok}&next=/app"
        ))
        .header("Host", "preview-alpha.example.com")
        .header("X-Forwarded-Proto", "https")
        .send()
        .await
        .unwrap();
    assert_eq!(r_https_exch.status(), StatusCode::FOUND);
    let https_set_cookie = r_https_exch
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        https_set_cookie.contains("; Secure"),
        "HTTPS exchange must set Secure attribute on arima_preview_sid"
    );
    let https_cookie_kv = https_set_cookie.split(';').next().unwrap().to_owned();
    let r_https_html = client
        .get(format!("http://{proxy_addr}/app"))
        .header("Host", "preview-alpha.example.com")
        .header("X-Forwarded-Proto", "https")
        .header("Cookie", &https_cookie_kv)
        .send()
        .await
        .unwrap();
    assert_eq!(r_https_html.status(), StatusCode::OK);
    let https_csp = r_https_html
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(https_csp.contains("frame-ancestors 'self' https://hq.example.com"));
    let https_body = r_https_html.text().await.unwrap();
    assert!(https_body.contains("const HQ_ORIGIN = \"https://hq.example.com\";"));

    // 6c. Caddy On-Demand TLS `ask` endpoint (`/__arima_preview/health?domain=...`):
    //     Allows plain health check and registered `preview-alpha.*`, rejects unregistered/arbitrary domains!
    let h_plain = client
        .get(format!("http://{proxy_addr}/__arima_preview/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(h_plain.status(), StatusCode::OK);

    let h_registered = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/health?domain=preview-alpha.example.com"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(h_registered.status(), StatusCode::OK);

    let h_unregistered = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/health?domain=preview-unregistered.example.com"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(
        h_unregistered.status(),
        StatusCode::FORBIDDEN,
        "Caddy ask endpoint must reject unregistered preview subdomains"
    );

    let h_arbitrary = client
        .get(format!(
            "http://{proxy_addr}/__arima_preview/health?domain=random.example.com"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(h_arbitrary.status(), StatusCode::FORBIDDEN);

    // 7. WebSocket / Vite HMR proxying succeeds with `arima_preview_sid` and rejects `hq_sid`-only.
    let mut bad_ws_req = format!("ws://{proxy_addr}/__vite_hmr")
        .into_client_request()
        .unwrap();
    bad_ws_req
        .headers_mut()
        .insert("Cookie", "hq_sid=secret-hq-cookie".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(bad_ws_req).await.is_err());

    let mut ok_ws_req = format!("ws://{proxy_addr}/__vite_hmr")
        .into_client_request()
        .unwrap();
    ok_ws_req
        .headers_mut()
        .insert("Cookie", preview_cookie_kv.parse().unwrap());
    ok_ws_req
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", "vite-hmr".parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(ok_ws_req).await.unwrap();
    ws.send(TungMsg::Text("ping-hmr".into())).await.unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert_eq!(reply.to_text().unwrap(), "hmr-echo:ping-hmr");

    handle.shutdown();
}
