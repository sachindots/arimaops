// SPDX-License-Identifier: AGPL-3.0-or-later

//! Upgraded Voice Adapters for Standup Calls:
//! - Checks vaulted OpenAI / Gemini API keys (never leaking key material)
//! - `GET /api/voice/status`
//! - `POST /api/voice/tts` (OpenAI `/v1/audio/speech` or Gemini TTS)
//! - `POST /api/voice/stt` (OpenAI `/v1/audio/transcriptions` or Gemini STT)

use arima_core::VoiceProvider;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::AppState;

const MAX_TTS_TEXT_CHARS: usize = 4096;
const MAX_STT_AUDIO_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProvidersAvailability {
    pub browser_web_speech: bool,
    pub openai: bool,
    pub gemini: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatusResponse {
    pub providers: VoiceProvidersAvailability,
    pub active_provider: VoiceProvider,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsRequest {
    pub text: String,
    pub voice: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsResponse {
    pub provider: String,
    pub mime_type: String,
    pub audio_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSttRequest {
    pub audio_base64: String,
    pub mime_type: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSttResponse {
    pub provider: String,
    pub text: String,
}

#[derive(Debug)]
pub enum VoiceError {
    BadRequest(String),
    NotConfigured { provider: String, message: String },
    Upstream(String),
}

fn normalize_provider(raw: &str) -> Result<&'static str, VoiceError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "openai" | "open-ai" => Ok("openai"),
        "gemini" => Ok("gemini"),
        other => Err(VoiceError::BadRequest(format!(
            "unsupported voice adapter provider '{other}': expected openai or gemini"
        ))),
    }
}

/// Resolves a vaulted (or env-configured) API key for `provider` without ever logging it.
pub fn resolve_provider_api_key(state: &AppState, provider: &str) -> Option<String> {
    if let Ok(Some(row)) = state.inner.vault_secrets.get_by_provider(provider) {
        let aad = format!("vault-secret:{}", row.id);
        if let Ok(raw) = state
            .inner
            .auth
            .vault()
            .decrypt(aad.as_bytes(), &row.secret_enc)
        {
            if let Ok(key) = String::from_utf8(raw) {
                let trimmed = key.trim().to_owned();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    let env_name = match provider {
        "openai" => "OPENAI_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => return None,
    };
    std::env::var(env_name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Returns current voice adapter availability without exposing any secret values.
#[must_use]
pub fn voice_status(state: &AppState) -> VoiceStatusResponse {
    let openai = resolve_provider_api_key(state, "openai").is_some();
    let gemini = resolve_provider_api_key(state, "gemini").is_some();
    let active_provider = state.active_voice_provider();
    VoiceStatusResponse {
        providers: VoiceProvidersAvailability {
            browser_web_speech: true,
            openai,
            gemini,
        },
        active_provider,
    }
}

/// Synthesizes speech using vaulted OpenAI or Gemini HTTP APIs.
pub async fn synthesize_speech(
    state: &AppState,
    req: VoiceTtsRequest,
) -> Result<VoiceTtsResponse, VoiceError> {
    let provider = normalize_provider(&req.provider)?;
    let text = req.text.trim();
    if text.is_empty() {
        return Err(VoiceError::BadRequest("text must not be empty".into()));
    }
    if text.chars().count() > MAX_TTS_TEXT_CHARS {
        return Err(VoiceError::BadRequest(format!(
            "text exceeds {MAX_TTS_TEXT_CHARS} character limit"
        )));
    }

    let Some(api_key) = resolve_provider_api_key(state, provider) else {
        let label = if provider == "openai" {
            "OpenAI"
        } else {
            "Gemini"
        };
        return Err(VoiceError::NotConfigured {
            provider: provider.to_owned(),
            message: format!(
                "{label} voice adapter is not configured. Add a {label} API key in Vault settings or switch to Browser Web Speech."
            ),
        });
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| VoiceError::Upstream(format!("HTTP client error: {e}")))?;

    if provider == "openai" {
        let base = std::env::var("ARIMA_OPENAI_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com".into());
        let url = format!("{}/v1/audio/speech", base.trim_end_matches('/'));
        let voice = req
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("alloy");

        let resp = client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&json!({
                "model": "gpt-4o-mini-tts",
                "input": text,
                "voice": voice,
                "response_format": "mp3"
            }))
            .send()
            .await
            .map_err(|e| VoiceError::Upstream(format!("OpenAI TTS request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(VoiceError::Upstream(format!(
                "OpenAI TTS returned HTTP {}",
                resp.status()
            )));
        }
        let audio = resp
            .bytes()
            .await
            .map_err(|e| VoiceError::Upstream(format!("failed reading OpenAI audio: {e}")))?;
        return Ok(VoiceTtsResponse {
            provider: "openai".into(),
            mime_type: "audio/mpeg".into(),
            audio_base64: BASE64.encode(&audio),
        });
    }

    // Gemini TTS via generateContent with AUDIO response modality.
    let base = std::env::var("ARIMA_GEMINI_BASE_URL")
        .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".into());
    let url = format!(
        "{}/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
        base.trim_end_matches('/')
    );
    let voice = req
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Kore");

    let resp = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .json(&json!({
            "contents": [{ "parts": [{ "text": text }] }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": { "voiceName": voice }
                    }
                }
            }
        }))
        .send()
        .await
        .map_err(|e| VoiceError::Upstream(format!("Gemini TTS request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(VoiceError::Upstream(format!(
            "Gemini TTS returned HTTP {}",
            resp.status()
        )));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| VoiceError::Upstream(format!("invalid Gemini TTS JSON: {e}")))?;
    let inline = body
        .pointer("/candidates/0/content/parts/0/inlineData")
        .ok_or_else(|| VoiceError::Upstream("Gemini TTS response missing inlineData".into()))?;
    let audio_b64 = inline
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| VoiceError::Upstream("Gemini TTS response missing audio data".into()))?
        .to_owned();
    let mime = inline
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("audio/wav")
        .to_owned();

    Ok(VoiceTtsResponse {
        provider: "gemini".into(),
        mime_type: mime,
        audio_base64: audio_b64,
    })
}

/// Transcribes base64 audio using vaulted OpenAI or Gemini HTTP APIs.
pub async fn transcribe_audio(
    state: &AppState,
    req: VoiceSttRequest,
) -> Result<VoiceSttResponse, VoiceError> {
    let provider = normalize_provider(&req.provider)?;
    let decoded = BASE64
        .decode(req.audio_base64.trim())
        .map_err(|_| VoiceError::BadRequest("audioBase64 must be valid base64".into()))?;
    if decoded.is_empty() {
        return Err(VoiceError::BadRequest("audio payload is empty".into()));
    }
    if decoded.len() > MAX_STT_AUDIO_BYTES {
        return Err(VoiceError::BadRequest(
            "audio payload exceeds 10 MiB limit".into(),
        ));
    }

    let Some(api_key) = resolve_provider_api_key(state, provider) else {
        let label = if provider == "openai" {
            "OpenAI"
        } else {
            "Gemini"
        };
        return Err(VoiceError::NotConfigured {
            provider: provider.to_owned(),
            message: format!(
                "{label} speech-to-text is not configured. Add a {label} API key in Vault settings or use Browser Web Speech."
            ),
        });
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| VoiceError::Upstream(format!("HTTP client error: {e}")))?;

    let mime_type = if req.mime_type.trim().is_empty() {
        "audio/webm"
    } else {
        req.mime_type.trim()
    };

    if provider == "openai" {
        // Send via OpenAI chat/audio transcription compatible JSON or multipart.
        let base = std::env::var("ARIMA_OPENAI_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com".into());
        let url = format!("{}/v1/audio/transcriptions", base.trim_end_matches('/'));
        let boundary = format!("----ArimaBoundary{}", uuid::Uuid::new_v4().simple());
        let ext = if mime_type.contains("wav") {
            "wav"
        } else if mime_type.contains("mp3") || mime_type.contains("mpeg") {
            "mp3"
        } else {
            "webm"
        };

        let mut payload = Vec::with_capacity(decoded.len() + 512);
        payload.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-4o-mini-transcribe\r\n\
                 --{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.{ext}\"\r\n\
                 Content-Type: {mime_type}\r\n\r\n"
            )
            .as_bytes(),
        );
        payload.extend_from_slice(&decoded);
        payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let resp = client
            .post(&url)
            .bearer_auth(&api_key)
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(payload)
            .send()
            .await
            .map_err(|e| VoiceError::Upstream(format!("OpenAI STT request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(VoiceError::Upstream(format!(
                "OpenAI STT returned HTTP {}",
                resp.status()
            )));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| VoiceError::Upstream(format!("invalid OpenAI STT JSON: {e}")))?;
        let text = body
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        return Ok(VoiceSttResponse {
            provider: "openai".into(),
            text,
        });
    }

    // Gemini inline audio transcription via generateContent.
    let base = std::env::var("ARIMA_GEMINI_BASE_URL")
        .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".into());
    let url = format!(
        "{}/v1beta/models/gemini-2.5-flash:generateContent",
        base.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .json(&json!({
            "contents": [{
                "parts": [
                    { "text": "Transcribe this spoken audio verbatim. Output only the transcript text." },
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": req.audio_base64.trim()
                        }
                    }
                ]
            }]
        }))
        .send()
        .await
        .map_err(|e| VoiceError::Upstream(format!("Gemini STT request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(VoiceError::Upstream(format!(
            "Gemini STT returned HTTP {}",
            resp.status()
        )));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| VoiceError::Upstream(format!("invalid Gemini STT JSON: {e}")))?;
    let text = body
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    Ok(VoiceSttResponse {
        provider: "gemini".into(),
        text,
    })
}
