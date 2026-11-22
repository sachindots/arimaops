// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use arima_db::{UsageEventInput, UsageRepo};
use chrono::Utc;
use serde_json::Value;

use crate::providers::{estimate_cost_usd, ProviderKind};
use crate::Result;

/// Incremental byte-offset JSONL usage tailer.
///
/// Tracks per-file byte offsets so HQ only parses newly appended complete lines instead of
/// re-reading entire multi-megabyte agent transcripts on every tick, and automatically resets
/// the offset to `0` if a file is truncated or rotated.
#[derive(Debug, Default, Clone)]
pub struct UsageTailer {
    offsets: HashMap<PathBuf, u64>,
}

impl UsageTailer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the last committed byte offset for `path`.
    #[must_use]
    pub fn offset_for(&self, path: &Path) -> u64 {
        self.offsets.get(path).copied().unwrap_or(0)
    }

    /// Incrementally reads new complete `\n`-terminated JSONL usage lines from `path`,
    /// detecting file truncation/rotation cleanly.
    pub fn poll_file(
        &mut self,
        path: &Path,
        default_project_id: &str,
        default_agent_id: &str,
    ) -> Result<Vec<UsageEventInput>> {
        if !path.exists() {
            self.offsets.remove(path);
            return Ok(Vec::new());
        }

        let mut file = File::open(path)?;
        let file_len = file.metadata()?.len();
        let mut offset = self.offsets.get(path).copied().unwrap_or(0);

        // Detect truncation or log rotation.
        if file_len < offset {
            offset = 0;
        }
        if file_len == offset {
            self.offsets.insert(path.to_path_buf(), offset);
            return Ok(Vec::new());
        }

        file.seek(SeekFrom::Start(offset))?;
        let mut buf = Vec::with_capacity(usize::try_from(file_len - offset).unwrap_or(4096));
        file.read_to_end(&mut buf)?;

        // Only consume up to the last complete newline so partial writes wait for next poll.
        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            return Ok(Vec::new());
        };
        let complete_slice = &buf[..=last_nl];
        let new_offset = offset + u64::try_from(complete_slice.len()).unwrap_or(0);
        self.offsets.insert(path.to_path_buf(), new_offset);

        let text = String::from_utf8_lossy(complete_slice);
        let mut events = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(ev) =
                parse_usage_jsonl_line(trimmed, default_project_id, default_agent_id)
            {
                events.push(ev);
            }
        }

        Ok(events)
    }

    /// Polls `path` and persists all newly discovered usage events into `repo`.
    pub fn poll_and_record(
        &mut self,
        path: &Path,
        default_project_id: &str,
        default_agent_id: &str,
        repo: &UsageRepo,
    ) -> Result<usize> {
        let events = self.poll_file(path, default_project_id, default_agent_id)?;
        for ev in &events {
            repo.record_usage(ev)?;
        }
        Ok(events.len())
    }
}

/// Parses a single JSONL line from an agent transcript or usage log into [`UsageEventInput`].
#[must_use]
pub fn parse_usage_jsonl_line(
    line: &str,
    default_project_id: &str,
    default_agent_id: &str,
) -> Option<UsageEventInput> {
    let val: Value = serde_json::from_str(line).ok()?;
    let usage_obj = val
        .get("usage")
        .or_else(|| val.get("message").and_then(|m| m.get("usage")))
        .or_else(|| val.get("usageMetadata"))
        .unwrap_or(&val);

    let input_tokens = usage_obj
        .get("input_tokens")
        .or_else(|| usage_obj.get("inputTokens"))
        .or_else(|| usage_obj.get("prompt_tokens"))
        .or_else(|| usage_obj.get("promptTokenCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let output_tokens = usage_obj
        .get("output_tokens")
        .or_else(|| usage_obj.get("outputTokens"))
        .or_else(|| usage_obj.get("completion_tokens"))
        .or_else(|| usage_obj.get("candidatesTokenCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let cache_read_tokens = usage_obj
        .get("cache_read_input_tokens")
        .or_else(|| usage_obj.get("cacheReadTokens"))
        .or_else(|| usage_obj.get("cached_tokens"))
        .or_else(|| usage_obj.get("cachedContentTokenCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    if input_tokens == 0 && output_tokens == 0 && cache_read_tokens == 0 {
        return None;
    }

    let project_id = val
        .get("projectId")
        .or_else(|| val.get("project_id"))
        .and_then(Value::as_str)
        .unwrap_or(default_project_id)
        .to_owned();
    let agent_id = val
        .get("agentId")
        .or_else(|| val.get("agent_id"))
        .and_then(Value::as_str)
        .unwrap_or(default_agent_id)
        .to_owned();
    let task_id = val
        .get("taskId")
        .or_else(|| val.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let account_id = val
        .get("accountId")
        .or_else(|| val.get("account_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let model = val
        .get("model")
        .or_else(|| val.get("message").and_then(|m| m.get("model")))
        .and_then(Value::as_str)
        .unwrap_or("claude-sonnet-4-6")
        .to_owned();

    let provider_str = val
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if model.contains("gpt") || model.contains("o1") || model.contains("o3") {
                "openai"
            } else if model.contains("gemini") {
                "gemini"
            } else if model.contains("deepseek") || model.contains('/') {
                "openrouter"
            } else {
                "anthropic"
            }
        });

    let provider_kind = match provider_str {
        "openai" => ProviderKind::OpenAi,
        "gemini" => ProviderKind::Gemini,
        "openrouter" => ProviderKind::OpenRouter,
        "bedrock" => ProviderKind::Bedrock,
        _ => ProviderKind::Anthropic,
    };

    let cost_usd = val
        .get("costUsd")
        .or_else(|| val.get("cost_usd"))
        .or_else(|| usage_obj.get("costUsd"))
        .and_then(Value::as_f64)
        .unwrap_or_else(|| {
            estimate_cost_usd(
                provider_kind,
                input_tokens,
                cache_read_tokens,
                output_tokens,
            )
        });

    let at_ms = val
        .get("at")
        .or_else(|| val.get("timestamp"))
        .and_then(Value::as_i64)
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    Some(UsageEventInput {
        project_id,
        agent_id,
        task_id,
        account_id,
        provider: provider_str.to_owned(),
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cost_usd,
        at_ms: Some(at_ms),
    })
}
