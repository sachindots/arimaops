// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{AgentError, Result};

/// Supported LLM API providers for native Rust HTTP+SSE execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Anthropic,
    OpenAi,
    Gemini,
    OpenRouter,
    Bedrock,
}

impl ProviderKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
            Self::OpenRouter => "openrouter",
            Self::Bedrock => "bedrock",
        }
    }

    #[must_use]
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com",
            Self::OpenAi => "https://api.openai.com",
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::OpenRouter => "https://openrouter.ai/api",
            Self::Bedrock => "https://bedrock-runtime.us-east-1.amazonaws.com",
        }
    }
}

/// Specialized seat role powered by native Rust HTTP+SSE runners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SeatRole {
    Lead,
    Reviewer,
    SecondOpinion,
    Verifier,
    Coder,
}

impl SeatRole {
    #[must_use]
    pub fn default_system_prompt(self) -> &'static str {
        match self {
            Self::Lead => {
                "You are the ArimaOps Lead agent. Interview the user with structured ask_user choices, moderate standup/discussion meetings, break work into tasks, and coordinate specialists."
            }
            Self::Reviewer => {
                "You are the ArimaOps Reviewer agent. Inspect diffs, check architectural invariants, and record_gate pass/fail or escalate disagreements."
            }
            Self::SecondOpinion => {
                "You are the ArimaOps Second-Opinion seat. Provide side-by-side Option A vs Option B trade-offs via propose_second_opinion or report_disagreement."
            }
            Self::Verifier => {
                "You are the ArimaOps Verifier seat. Run verification suites, capture evidence via attach_evidence, and record_gate verification results."
            }
            Self::Coder => {
                "You are an ArimaOps Coding seat. Implement assigned tasks cleanly and report blockers via ask_user or request_meeting."
            }
        }
    }

    /// Built-in MCP tool definitions exposed to this seat role.
    #[must_use]
    pub fn default_tools(self) -> Vec<ToolDefinition> {
        let mut tools = vec![
            ToolDefinition {
                name: "ask_user".into(),
                description: "Ask the user structured multiple-choice questions with a (Recommended) default.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "details": { "type": "string" },
                        "questions": { "type": "array" }
                    },
                    "required": ["title", "questions"]
                }),
            },
            ToolDefinition {
                name: "request_meeting".into(),
                description: "Request an interactive Standup or Discussion session with the team and owner.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "urgency": { "type": "string", "enum": ["low", "normal", "high"] },
                        "agenda": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["title"]
                }),
            },
        ];

        if matches!(self, Self::Reviewer | Self::SecondOpinion | Self::Lead) {
            tools.push(ToolDefinition {
                name: "propose_second_opinion".into(),
                description: "Present side-by-side Option A vs Option B rationale and risks.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "optionA": { "type": "object" },
                        "optionB": { "type": "object" }
                    },
                    "required": ["title", "optionA", "optionB"]
                }),
            });
        }

        if matches!(self, Self::Reviewer | Self::Verifier | Self::Lead) {
            tools.push(ToolDefinition {
                name: "record_gate".into(),
                description: "Record gate pass or fail with full Markdown rationale.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "taskId": { "type": "string" },
                        "gateId": { "type": "string" },
                        "state": { "type": "string", "enum": ["passed", "failed", "reset"] },
                        "note": { "type": "string" }
                    },
                    "required": ["taskId", "gateId", "state"]
                }),
            });
        }

        tools
    }
}

/// Tool schema exposed to LLM providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Single conversation turn passed to a [`ModelRunner`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Unified request configuration for any native Rust LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub provider: ProviderKind,
    pub model: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub seat_role: SeatRole,
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: u32,
    pub temperature: f32,
}

impl ModelRequest {
    #[must_use]
    pub fn new(
        provider: ProviderKind,
        model: impl Into<String>,
        api_key: impl Into<String>,
        seat_role: SeatRole,
        messages: Vec<ChatMessage>,
    ) -> Self {
        Self {
            provider,
            model: model.into(),
            api_key: api_key.into(),
            base_url: None,
            seat_role,
            system_prompt: None,
            messages,
            tools: seat_role.default_tools(),
            max_tokens: 4096,
            temperature: 0.2,
        }
    }
}

/// Structured tool invocation extracted from a streaming or non-streaming model completion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Normalized token and cost metrics extracted from a provider completion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
}

/// Real-time incremental events parsed from an SSE stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ModelStreamEvent {
    TextDelta { text: String },
    ReasoningDelta { text: String },
    ToolCall(ExtractedToolCall),
    Usage(TokenUsage),
    Done,
}

/// Complete aggregated response from a [`ModelRunner`] execution.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<ExtractedToolCall>,
    pub usage: TokenUsage,
    pub events: Vec<ModelStreamEvent>,
}

/// Async trait for executing native LLM completions over HTTP+SSE.
pub trait ModelRunner: Send + Sync {
    fn run_stream<'a>(
        &'a self,
        req: &'a ModelRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ModelResponse>> + Send + 'a>>;
}

/// Native Rust HTTP+SSE runner powered by `reqwest` (`rustls-tls`, `json`, `stream`).
#[derive(Debug, Clone)]
pub struct HttpSseModelRunner {
    client: reqwest::Client,
}

impl Default for HttpSseModelRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpSseModelRunner {
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .build()
            .expect("reqwest rustls client");
        Self { client }
    }

    /// Constructs the provider-specific target URL and JSON request payload.
    #[must_use]
    pub fn build_provider_payload(req: &ModelRequest) -> (String, Value) {
        let base = req
            .base_url
            .as_deref()
            .unwrap_or_else(|| req.provider.default_base_url())
            .trim_end_matches('/');
        let sys = req
            .system_prompt
            .as_deref()
            .unwrap_or_else(|| req.seat_role.default_system_prompt());

        match req.provider {
            ProviderKind::Anthropic => {
                let tools: Vec<Value> = req
                    .tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.input_schema,
                        })
                    })
                    .collect();
                let msgs: Vec<Value> = req
                    .messages
                    .iter()
                    .map(|m| json!({ "role": m.role, "content": m.content }))
                    .collect();
                (
                    format!("{base}/v1/messages"),
                    json!({
                        "model": req.model,
                        "system": sys,
                        "messages": msgs,
                        "tools": tools,
                        "max_tokens": req.max_tokens,
                        "temperature": req.temperature,
                        "stream": true,
                    }),
                )
            }
            ProviderKind::Gemini => {
                let func_decls: Vec<Value> = req
                    .tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        })
                    })
                    .collect();
                let contents: Vec<Value> = req
                    .messages
                    .iter()
                    .map(|m| {
                        let role = if m.role == "assistant" { "model" } else { "user" };
                        json!({
                            "role": role,
                            "parts": [{ "text": m.content }]
                        })
                    })
                    .collect();
                (
                    format!(
                        "{base}/v1beta/models/{}:streamGenerateContent?alt=sse",
                        req.model
                    ),
                    json!({
                        "systemInstruction": { "parts": [{ "text": sys }] },
                        "contents": contents,
                        "tools": [{ "functionDeclarations": func_decls }],
                        "generationConfig": {
                            "maxOutputTokens": req.max_tokens,
                            "temperature": req.temperature
                        }
                    }),
                )
            }
            ProviderKind::OpenAi | ProviderKind::OpenRouter | ProviderKind::Bedrock => {
                let path = if base.ends_with("/v1") {
                    format!("{base}/chat/completions")
                } else {
                    format!("{base}/v1/chat/completions")
                };
                let mut msgs = vec![json!({ "role": "system", "content": sys })];
                for m in &req.messages {
                    msgs.push(json!({ "role": m.role, "content": m.content }));
                }
                let tools: Vec<Value> = req
                    .tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "description": t.description,
                                "parameters": t.input_schema,
                            }
                        })
                    })
                    .collect();
                (
                    path,
                    json!({
                        "model": req.model,
                        "messages": msgs,
                        "tools": tools,
                        "max_tokens": req.max_tokens,
                        "temperature": req.temperature,
                        "stream": true,
                        "stream_options": { "include_usage": true }
                    }),
                )
            }
        }
    }
}

impl ModelRunner for HttpSseModelRunner {
    fn run_stream<'a>(
        &'a self,
        req: &'a ModelRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ModelResponse>> + Send + 'a>> {
        Box::pin(async move {
            let (url, body) = Self::build_provider_payload(req);
            let mut builder = self
                .client
                .post(&url)
                .header("content-type", "application/json")
                .header("accept", "text/event-stream");

            builder = match req.provider {
                ProviderKind::Anthropic => builder
                    .header("x-api-key", &req.api_key)
                    .header("anthropic-version", "2023-06-01"),
                ProviderKind::Gemini => builder.header("x-goog-api-key", &req.api_key),
                ProviderKind::OpenAi | ProviderKind::OpenRouter | ProviderKind::Bedrock => {
                    builder.header("authorization", format!("Bearer {}", req.api_key))
                }
            };

            let resp = builder
                .json(&body)
                .send()
                .await
                .map_err(|e| AgentError::Provider(format!("http request failed: {e}")))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let err_text = resp.text().await.unwrap_or_default();
                return Err(AgentError::Provider(format!(
                    "provider {} returned HTTP {}: {}",
                    req.provider.as_str(),
                    status.as_u16(),
                    err_text
                )));
            }

            let mut parser = SseStreamAccumulator::new(req.provider);
            let mut byte_stream = resp.bytes_stream();
            while let Some(chunk_res) = byte_stream.next().await {
                let chunk = chunk_res
                    .map_err(|e| AgentError::Provider(format!("stream read error: {e}")))?;
                parser.feed_bytes(&chunk);
            }
            parser.finish()
        })
    }
}

#[derive(Debug, Default)]
struct PartialToolCall {
    id: String,
    name: String,
    args_buf: String,
}

/// Incremental SSE line parser & tool-call accumulator supporting Anthropic, OpenAI,
/// Gemini, OpenRouter/DeepSeek, and Bedrock event streams.
pub struct SseStreamAccumulator {
    provider: ProviderKind,
    line_buf: String,
    response: ModelResponse,
    partial_tools: HashMap<usize, PartialToolCall>,
}

impl SseStreamAccumulator {
    #[must_use]
    pub fn new(provider: ProviderKind) -> Self {
        Self {
            provider,
            line_buf: String::new(),
            response: ModelResponse::default(),
            partial_tools: HashMap::new(),
        }
    }

    /// Feeds raw UTF-8 SSE bytes into the accumulator.
    pub fn feed_bytes(&mut self, bytes: &[u8]) {
        let chunk_str = String::from_utf8_lossy(bytes);
        self.line_buf.push_str(&chunk_str);

        while let Some(newline_pos) = self.line_buf.find('\n') {
            let line = self.line_buf[..newline_pos].trim_end_matches('\r').to_owned();
            self.line_buf.drain(..=newline_pos);
            self.process_line(&line);
        }
    }

    /// Flushes any remaining partial lines and finalizes buffered tool calls.
    pub fn finish(mut self) -> Result<ModelResponse> {
        if !self.line_buf.trim().is_empty() {
            let remaining = self.line_buf.trim().to_owned();
            self.line_buf.clear();
            self.process_line(&remaining);
        }

        let mut indices: Vec<usize> = self.partial_tools.keys().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            if let Some(pt) = self.partial_tools.remove(&idx) {
                if !pt.name.is_empty() {
                    let args: Value = serde_json::from_str(&pt.args_buf)
                        .unwrap_or_else(|_| json!({ "raw": pt.args_buf }));
                    let call = ExtractedToolCall {
                        id: if pt.id.is_empty() {
                            format!("call_{idx}")
                        } else {
                            pt.id
                        },
                        name: pt.name,
                        arguments: args,
                    };
                    self.response
                        .events
                        .push(ModelStreamEvent::ToolCall(call.clone()));
                    self.response.tool_calls.push(call);
                }
            }
        }

        if self.response.usage.cost_usd == 0.0
            && (self.response.usage.input_tokens > 0 || self.response.usage.output_tokens > 0)
        {
            self.response.usage.cost_usd = estimate_cost_usd(
                self.provider,
                self.response.usage.input_tokens,
                self.response.usage.cache_read_tokens,
                self.response.usage.output_tokens,
            );
        }

        self.response.events.push(ModelStreamEvent::Done);
        Ok(self.response)
    }

    fn process_line(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(':') || trimmed.starts_with("event:") {
            return;
        }
        let payload = trimmed
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(trimmed);

        if payload == "[DONE]" {
            return;
        }

        let Ok(val) = serde_json::from_str::<Value>(payload) else {
            return;
        };

        match self.provider {
            ProviderKind::Anthropic => self.handle_anthropic_event(&val),
            ProviderKind::Gemini => self.handle_gemini_event(&val),
            ProviderKind::OpenAi | ProviderKind::OpenRouter | ProviderKind::Bedrock => {
                self.handle_openai_compatible_event(&val);
            }
        }
    }

    fn handle_anthropic_event(&mut self, val: &Value) {
        let ev_type = val.get("type").and_then(Value::as_str).unwrap_or("");
        match ev_type {
            "message_start" => {
                if let Some(u) = val.get("message").and_then(|m| m.get("usage")) {
                    self.response.usage.input_tokens +=
                        u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
                    self.response.usage.cache_read_tokens += u
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                }
            }
            "content_block_start" => {
                let idx = val
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(0);
                if let Some(cb) = val.get("content_block") {
                    if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let id = cb
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let name = cb
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let mut args_buf = String::new();
                        if let Some(inp) = cb.get("input") {
                            if inp.is_object() && !inp.as_object().unwrap().is_empty() {
                                args_buf = inp.to_string();
                            }
                        }
                        self.partial_tools
                            .insert(idx, PartialToolCall { id, name, args_buf });
                    }
                }
            }
            "content_block_delta" => {
                let idx = val
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(0);
                if let Some(delta) = val.get("delta") {
                    let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
                    if dtype == "text_delta" {
                        if let Some(t) = delta.get("text").and_then(Value::as_str) {
                            self.response.text.push_str(t);
                            self.response.events.push(ModelStreamEvent::TextDelta {
                                text: t.to_owned(),
                            });
                        }
                    } else if dtype == "thinking_delta" {
                        if let Some(t) = delta.get("thinking").and_then(Value::as_str) {
                            self.response.reasoning.push_str(t);
                            self.response
                                .events
                                .push(ModelStreamEvent::ReasoningDelta {
                                    text: t.to_owned(),
                                });
                        }
                    } else if dtype == "input_json_delta" {
                        if let Some(part) = delta.get("partial_json").and_then(Value::as_str) {
                            self.partial_tools
                                .entry(idx)
                                .or_default()
                                .args_buf
                                .push_str(part);
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(u) = val.get("usage") {
                    self.response.usage.output_tokens +=
                        u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
                    self.response
                        .events
                        .push(ModelStreamEvent::Usage(self.response.usage.clone()));
                }
            }
            _ => {}
        }
    }

    fn handle_openai_compatible_event(&mut self, val: &Value) {
        if let Some(choices) = val.get("choices").and_then(Value::as_array) {
            for choice in choices {
                if let Some(delta) = choice.get("delta") {
                    if let Some(content) = delta.get("content").and_then(Value::as_str) {
                        if !content.is_empty() {
                            self.response.text.push_str(content);
                            self.response.events.push(ModelStreamEvent::TextDelta {
                                text: content.to_owned(),
                            });
                        }
                    }
                    if let Some(reasoning) = delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning"))
                        .and_then(Value::as_str)
                    {
                        if !reasoning.is_empty() {
                            self.response.reasoning.push_str(reasoning);
                            self.response
                                .events
                                .push(ModelStreamEvent::ReasoningDelta {
                                    text: reasoning.to_owned(),
                                });
                        }
                    }
                    if let Some(tcs) = delta.get("tool_calls").and_then(Value::as_array) {
                        for tc in tcs {
                            let idx = tc
                                .get("index")
                                .and_then(Value::as_u64)
                                .and_then(|n| usize::try_from(n).ok())
                                .unwrap_or(0);
                            let entry = self.partial_tools.entry(idx).or_default();
                            if let Some(id) = tc.get("id").and_then(Value::as_str) {
                                if !id.is_empty() {
                                    entry.id = id.to_owned();
                                }
                            }
                            if let Some(func) = tc.get("function") {
                                if let Some(name) = func.get("name").and_then(Value::as_str) {
                                    if !name.is_empty() {
                                        entry.name.push_str(name);
                                    }
                                }
                                if let Some(args_chunk) =
                                    func.get("arguments").and_then(Value::as_str)
                                {
                                    entry.args_buf.push_str(args_chunk);
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Some(u) = val.get("usage") {
            let prompt = u.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0);
            let completion = u
                .get("completion_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cached = u
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if prompt > 0 || completion > 0 {
                self.response.usage.input_tokens = prompt;
                self.response.usage.output_tokens = completion;
                self.response.usage.cache_read_tokens = cached;
                self.response
                    .events
                    .push(ModelStreamEvent::Usage(self.response.usage.clone()));
            }
        }
    }

    fn handle_gemini_event(&mut self, val: &Value) {
        if let Some(candidates) = val.get("candidates").and_then(Value::as_array) {
            for cand in candidates {
                if let Some(parts) = cand
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(Value::as_array)
                {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            self.response.text.push_str(text);
                            self.response.events.push(ModelStreamEvent::TextDelta {
                                text: text.to_owned(),
                            });
                        }
                        if let Some(fc) = part.get("functionCall") {
                            let name = fc
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                            let call = ExtractedToolCall {
                                id: format!("gemini_call_{}", self.response.tool_calls.len() + 1),
                                name,
                                arguments: args,
                            };
                            self.response
                                .events
                                .push(ModelStreamEvent::ToolCall(call.clone()));
                            self.response.tool_calls.push(call);
                        }
                    }
                }
            }
        }

        if let Some(um) = val.get("usageMetadata") {
            self.response.usage.input_tokens = um
                .get("promptTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(self.response.usage.input_tokens);
            self.response.usage.output_tokens = um
                .get("candidatesTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(self.response.usage.output_tokens);
            self.response.usage.cache_read_tokens = um
                .get("cachedContentTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(self.response.usage.cache_read_tokens);
            self.response
                .events
                .push(ModelStreamEvent::Usage(self.response.usage.clone()));
        }
    }
}

#[must_use]
pub fn estimate_cost_usd(
    provider: ProviderKind,
    input_tokens: i64,
    cached_tokens: i64,
    output_tokens: i64,
) -> f64 {
    let (in_per_m, cached_per_m, out_per_m) = match provider {
        ProviderKind::Anthropic => (3.0, 0.30, 15.0),
        ProviderKind::OpenAi => (2.5, 0.25, 10.0),
        ProviderKind::Gemini => (1.25, 0.125, 5.0),
        ProviderKind::OpenRouter => (1.0, 0.10, 3.0),
        ProviderKind::Bedrock => (3.0, 0.30, 15.0),
    };
    let in_cost = (input_tokens.max(0) as f64 / 1_000_000.0) * in_per_m;
    let cache_cost = (cached_tokens.max(0) as f64 / 1_000_000.0) * cached_per_m;
    let out_cost = (output_tokens.max(0) as f64 / 1_000_000.0) * out_per_m;
    in_cost + cache_cost + out_cost
}
