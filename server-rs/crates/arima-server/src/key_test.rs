// SPDX-License-Identifier: AGPL-3.0-or-later

//! "Does this API key work?" Asks the provider's cheapest read-only endpoint and reports in plain words.
//! The key is used for that one request and never stored, logged or echoed back.

use std::time::Duration;

use serde_json::{json, Value};

use crate::state::AppState;

/// What the person is told. `ok` is `None` when the key couldn't be judged (network trouble, a provider we can't test).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCheck {
    pub ok: Option<bool>,
    pub message: String,
}

fn verdict(ok: Option<bool>, message: impl Into<String>) -> KeyCheck {
    KeyCheck { ok, message: message.into() }
}

/// How each provider is asked: the host, a read-only path, and how the key travels.
fn target(provider: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match provider {
        "anthropic" => ("https://api.anthropic.com", "/v1/models?limit=1", "x-api-key"),
        "openai" => ("https://api.openai.com", "/v1/models", "bearer"),
        "google" => ("https://generativelanguage.googleapis.com", "/v1beta/models?pageSize=1", "x-goog-api-key"),
        "openrouter" => ("https://openrouter.ai", "/api/v1/auth/key", "bearer"),
        "nvidia" => ("https://integrate.api.nvidia.com", "/v1/models", "bearer"),
        "deepseek" => ("https://api.deepseek.com", "/models", "bearer"),
        _ => return None,
    })
}

const NAMES: &[(&str, &str)] = &[("anthropic", "Anthropic"), ("openai", "OpenAI"), ("google", "Google"), ("openrouter", "OpenRouter"), ("nvidia", "NVIDIA"), ("deepseek", "DeepSeek")];

fn name(provider: &str) -> &str {
    NAMES.iter().find(|(id, _)| *id == provider).map_or(provider, |(_, n)| n)
}

/// Checks `secret` against `provider`. `base` replaces the provider's host (tests point it at a local server).
pub async fn check(provider: &str, secret: &str, base: Option<&str>) -> KeyCheck {
    let secret = secret.trim();
    let Some((host, path, style)) = target(provider) else {
        return verdict(None, "This provider can't be checked from here. Save it and the agent will tell you if it fails.");
    };
    if secret.len() < 8 || secret.len() > 4096 || secret.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return verdict(Some(false), "That doesn't look like a whole key. Copy it again, with no spaces or line breaks.");
    }
    let provider_name = name(provider);
    let url = format!("{}{path}", base.unwrap_or(host));
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return verdict(None, "Couldn't start the check. Try again."),
    };
    let mut req = client.get(url);
    req = match style {
        "x-api-key" => req.header("x-api-key", secret).header("anthropic-version", "2023-06-01"),
        "x-goog-api-key" => req.header("x-goog-api-key", secret),
        _ => req.bearer_auth(secret),
    };
    match req.send().await {
        Err(e) if e.is_timeout() => verdict(None, format!("{provider_name} didn't answer in time, so the key wasn't checked. Try again in a moment.")),
        Err(_) => verdict(None, format!("Couldn't reach {provider_name}, so the key wasn't checked. Check this server's internet connection.")),
        Ok(resp) => match resp.status().as_u16() {
            200..=299 => verdict(Some(true), format!("The key works with {provider_name}.")),
            401 | 403 => verdict(Some(false), format!("{provider_name} rejected this key. Check that you copied all of it and that it is turned on in your {provider_name} account.")),
            429 => verdict(Some(true), format!("The key is valid. {provider_name} is limiting requests right now, which is fine.")),
            code => verdict(None, format!("{provider_name} answered with an error ({code}), so the key wasn't checked. Try again later.")),
        },
    }
}

/// `testAccountKey [provider, secret, requestId]`: answers with a `key.tested` event for the project's sockets.
pub async fn run(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let text = |i: usize, max: usize| args.get(i).and_then(Value::as_str).unwrap_or("").chars().take(max).collect::<String>();
    let (provider, secret, request) = (text(0, 40), text(1, 4200), text(2, 80));
    let result = check(&provider, &secret, None).await;
    let event = json!({ "type": "key.tested", "projectId": project_id, "requestId": request, "provider": provider, "ok": result.ok, "message": result.message });
    state.inner.ws_hub.broadcast_project(project_id, &event.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, routing::get, Router};

    async fn fake(accept: &'static str) -> String {
        let app = Router::new().route(
            "/v1/models",
            get(move |h: HeaderMap| async move {
                let given = h.get("x-api-key").and_then(|v| v.to_str().ok()).or_else(|| h.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))).unwrap_or("");
                if given == accept { (axum::http::StatusCode::OK, "{}") } else { (axum::http::StatusCode::UNAUTHORIZED, "{}") }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    #[tokio::test]
    async fn good_bad_malformed_and_untestable_keys_get_plain_answers() {
        let base = fake("sk-good-key-1234").await;
        assert_eq!(check("openai", "sk-good-key-1234", Some(&base)).await.ok, Some(true));
        assert_eq!(check("openai", " sk-good-key-1234 ", Some(&base)).await.ok, Some(true), "pasted whitespace is trimmed");
        let bad = check("openai", "sk-wrong-key-9999", Some(&base)).await;
        assert_eq!(bad.ok, Some(false));
        assert!(!bad.message.contains("sk-wrong"), "the key is never echoed: {}", bad.message);
        assert_eq!(check("openai", "sk-has a space", Some(&base)).await.ok, Some(false));
        assert_eq!(check("openai", "short", Some(&base)).await.ok, Some(false));
        assert_eq!(check("amd", "some-long-enough-key", Some(&base)).await.ok, None, "a provider without a check says so");
        let down = check("openai", "sk-good-key-1234", Some("http://127.0.0.1:9")).await;
        assert_eq!(down.ok, None, "an unreachable provider is 'not checked', not 'bad key'");
    }
}
