// SPDX-License-Identifier: AGPL-3.0-or-later

//! Hybrid agent orchestration engine for ArimaOps v2.0 (Milestone 2):
//! - Native Rust HTTP+SSE runners (`providers`: Anthropic, OpenAI, Gemini, OpenRouter/DeepSeek, Bedrock)
//! - Per-agent Tokio supervisor (`supervisor`) with state locks, setup sequencing, and persisted desired state
//! - Docker Engine spec builder (`docker`) & `sbx` adapter (`sbx`) with mandatory default CPU/RAM quotas (`2 CPU / 2048 MB`)
//! - Incremental byte-offset JSONL usage tailer (`usage`) with truncation/rotation detection

pub mod docker;
pub mod engine;
pub mod providers;
pub mod sbx;
pub mod supervisor;
pub mod usage;

use thiserror::Error;

pub use engine::{ContainerState, DockerEngine};
pub use docker::{ContainerLaunchSpec, ContainerSpecInput, DockerEngineLauncher, SecretDelivery};
pub use providers::{
    estimate_cost_usd, ChatMessage, ExtractedToolCall, HttpSseModelRunner, ModelRequest,
    ModelResponse, ModelRunner, ModelStreamEvent, ProviderKind, SeatRole, SseStreamAccumulator,
    TokenUsage, ToolDefinition,
};
pub use sbx::{SbxAdapter, SbxCommandSpec};
pub use supervisor::{
    AgentSupervisor, SetupSequenceStep, SupervisedAgentSnapshot, SupervisedSessionState,
};
pub use usage::{parse_usage_jsonl_line, UsageTailer};

pub const DEFAULT_CONTAINER_CPUS: u32 = 2;
pub const DEFAULT_CONTAINER_MEMORY_GB: u32 = 2;
pub const DEFAULT_CONTAINER_MEMORY_MB: u32 = 2048;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("database error: {0}")]
    Db(#[from] arima_db::DbError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("invalid agent configuration: {0}")]
    InvalidConfig(String),
    #[error("security violation: {0}")]
    SecurityViolation(String),
    #[error("docker engine: {0}")]
    Engine(String),
}

pub type Result<T> = std::result::Result<T, AgentError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;
    use arima_db::{Db, DbError, UsageRepo};
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn container_defaults_enforce_bounded_resources_and_block_argv_secrets() {
        const { assert!(DEFAULT_CONTAINER_CPUS == 2) };
        const { assert!(DEFAULT_CONTAINER_MEMORY_GB == 2) };
        const { assert!(DEFAULT_CONTAINER_MEMORY_MB == 2048) };

        let launcher = DockerEngineLauncher::new();
        let spec = launcher
            .build_spec(&ContainerSpecInput {
                project_slug: "alpha".into(),
                agent_id: "coder".into(),
                image: "arimaops/agent:latest".into(),
                program: "claude".into(),
                args: vec!["--output-format".into(), "stream-json".into()],
                workspace_host_path: "/tmp/alpha".into(),
                cpus: None,
                memory_mb: None,
                env: HashMap::new(),
                egress_proxy_url: Some("http://172.30.0.1:7422".into()),
            })
            .unwrap();

        assert_eq!(spec.cpus, 2);
        assert_eq!(spec.memory_mb, 2048);
        assert_eq!(spec.nano_cpus, 2_000_000_000);
        assert_eq!(spec.memory_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(
            launcher.lookup_ip("hq-alpha-coder"),
            Some(spec.fixed_ipv4)
        );

        // Reject shell interpolation and argv secrets.
        let shell_err = launcher.build_spec(&ContainerSpecInput {
            project_slug: "alpha".into(),
            agent_id: "coder".into(),
            image: "arimaops/agent:latest".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "claude".into()],
            workspace_host_path: "/tmp/alpha".into(),
            cpus: Some(4),
            memory_mb: Some(4096),
            env: HashMap::new(),
            egress_proxy_url: None,
        });
        assert!(shell_err.is_err());

        let secret_err = launcher.build_spec(&ContainerSpecInput {
            project_slug: "alpha".into(),
            agent_id: "coder".into(),
            image: "arimaops/agent:latest".into(),
            program: "claude".into(),
            args: vec!["--api-key=sk-ant-secret".into()],
            workspace_host_path: "/tmp/alpha".into(),
            cpus: None,
            memory_mb: None,
            env: HashMap::new(),
            egress_proxy_url: None,
        });
        assert!(secret_err.is_err());

        // Sbx adapter also enforces 2 CPU / 2048 MB defaults and stdin secret passing.
        let sbx = SbxAdapter::default();
        let run_cmd = sbx
            .build_run_command("hq-alpha-coder", None, None, "claude", &[])
            .unwrap();
        assert_eq!(run_cmd.cpus, 2);
        assert_eq!(run_cmd.memory_mb, 2048);

        let sec_cmd = sbx
            .build_set_secret_command(Some("hq-alpha-coder"), "anthropic", "sk-ant-secret")
            .unwrap();
        assert_eq!(sec_cmd.stdin_secret.as_deref(), Some("sk-ant-secret"));
        assert!(!sec_cmd.argv.iter().any(|a| a.contains("sk-ant-secret")));
    }

    #[tokio::test]
    async fn native_http_sse_runners_parse_anthropic_openai_gemini_and_openrouter_streams() {
        // 1. Live wire test over local TCP mock server for Anthropic Messages SSE + tool_use extraction.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req_buf = [0u8; 4096];
            let _ = sock.read(&mut req_buf).await.unwrap();

            let sse_body = concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":120,\"cache_read_input_tokens\":80}}}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Let me ask one question.\"}}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"ask_user\",\"input\":{}}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"title\\\":\\\"Auth mode\\\"\"  }}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\",\\\"questions\\\":[]}\"}}\n\n",
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":45}}\n\n",
                "event: message_stop\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            let http_resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse_body.len(),
                sse_body
            );
            sock.write_all(http_resp.as_bytes()).await.unwrap();
        });

        let runner = HttpSseModelRunner::new();
        let mut req = ModelRequest::new(
            ProviderKind::Anthropic,
            "claude-sonnet-4-6",
            "test-key",
            SeatRole::Lead,
            vec![ChatMessage {
                role: "user".into(),
                content: "Plan auth".into(),
            }],
        );
        req.base_url = Some(format!("http://{addr}"));

        let resp = runner.run_stream(&req).await.unwrap();
        assert_eq!(resp.text, "Let me ask one question.");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "ask_user");
        assert_eq!(resp.tool_calls[0].arguments["title"], "Auth mode");
        assert_eq!(resp.usage.input_tokens, 120);
        assert_eq!(resp.usage.cache_read_tokens, 80);
        assert_eq!(resp.usage.output_tokens, 45);
        assert!(resp.usage.cost_usd > 0.0);

        // 2. OpenRouter / DeepSeek reasoning + OpenAI tool_calls SSE parsing.
        let mut or_acc = SseStreamAccumulator::new(ProviderKind::OpenRouter);
        or_acc.feed_bytes(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Analyzing A vs B...\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"Option A is safer.\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_so1\",\"function\":{\"name\":\"propose_second_opinion\",\"arguments\":\"{\\\"title\\\":\\\"DB choice\\\"}\"}}]}}]}\n\n",
                "data: {\"usage\":{\"prompt_tokens\":200,\"completion_tokens\":60,\"prompt_tokens_details\":{\"cached_tokens\":50}}}\n\n",
                "data: [DONE]\n\n"
            )
            .as_bytes(),
        );
        let or_resp = or_acc.finish().unwrap();
        assert_eq!(or_resp.reasoning, "Analyzing A vs B...");
        assert_eq!(or_resp.text, "Option A is safer.");
        assert_eq!(or_resp.tool_calls.len(), 1);
        assert_eq!(or_resp.tool_calls[0].name, "propose_second_opinion");
        assert_eq!(or_resp.usage.input_tokens, 200);
        assert_eq!(or_resp.usage.cache_read_tokens, 50);
        assert_eq!(or_resp.usage.output_tokens, 60);

        // 3. Gemini streamGenerateContent SSE + functionCall extraction.
        let mut gem_acc = SseStreamAccumulator::new(ProviderKind::Gemini);
        gem_acc.feed_bytes(
            b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gate verified.\"},{\"functionCall\":{\"name\":\"record_gate\",\"args\":{\"taskId\":\"T01\",\"gateId\":\"verify\",\"state\":\"passed\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":300,\"candidatesTokenCount\":40,\"cachedContentTokenCount\":100}}\n\n",
        );
        let gem_resp = gem_acc.finish().unwrap();
        assert_eq!(gem_resp.text, "Gate verified.");
        assert_eq!(gem_resp.tool_calls.len(), 1);
        assert_eq!(gem_resp.tool_calls[0].name, "record_gate");
        assert_eq!(gem_resp.tool_calls[0].arguments["state"], "passed");
        assert_eq!(gem_resp.usage.input_tokens, 300);
        assert_eq!(gem_resp.usage.cache_read_tokens, 100);
        assert_eq!(gem_resp.usage.output_tokens, 40);
    }

    #[tokio::test]
    async fn supervisor_prevents_concurrent_start_races_sequences_setup_and_persists_desired_state() {
        let db = Db::open_in_memory().unwrap();
        db.transaction(|conn| {
            conn.execute(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                 VALUES ('proj-alpha', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
                [],
            )?;
            Ok::<_, DbError>(())
        })
        .unwrap();

        let sup = AgentSupervisor::new(db.clone(), 1);

        // Concurrent start_agent calls on the same agent must serialize and start once.
        let s1 = sup.clone();
        let s2 = sup.clone();
        let (r1, r2) = tokio::join!(
            s1.start_agent("proj-alpha", "coder", Some("T01")),
            s2.start_agent("proj-alpha", "coder", Some("T01"))
        );
        assert_ne!(r1.unwrap(), r2.unwrap(), "exactly one concurrent start must win");

        let snap = sup.snapshot("proj-alpha", "coder").await;
        assert_eq!(snap.state, SupervisedSessionState::Running);
        assert!(snap.desired_running);
        assert!(snap.poll_loop_active);
        assert_eq!(snap.start_generation, 1);
        assert_eq!(
            snap.completed_steps,
            vec![
                SetupSequenceStep::WorkspaceSync,
                SetupSequenceStep::DeliverablePrep,
                SetupSequenceStep::EnvAndMcpReady,
                SetupSequenceStep::DispatchStartTask,
            ]
        );

        // Outbox received the "Start task" message after setup steps finished.
        let msg = sup
            .poll_next_outbox("proj-alpha", "coder", 1, 0)
            .unwrap()
            .unwrap();
        assert!(msg.payload_json.contains("Start task"));

        // New supervisor instance after simulated HQ restart resumes desired agents under epoch 2.
        let sup_restarted = AgentSupervisor::new(db, 2);
        let resumed = sup_restarted
            .resume_desired_agents("proj-alpha")
            .await
            .unwrap();
        assert_eq!(resumed, vec!["coder".to_owned()]);
    }

    #[test]
    fn incremental_usage_tailer_tracks_byte_offsets_and_handles_truncation() {
        let dir = TempDir::new().unwrap();
        let log_path = dir.path().join("transcript.jsonl");
        let db = Db::open_in_memory().unwrap();
        db.transaction(|conn| {
            conn.execute(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                 VALUES ('proj-alpha', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
                [],
            )?;
            Ok::<_, DbError>(())
        })
        .unwrap();
        let usage_repo = UsageRepo::new(db);
        let mut tailer = UsageTailer::new();

        // Write 2 complete lines + 1 partial trailing line (no newline yet).
        {
            let mut f = std::fs::File::create(&log_path).unwrap();
            writeln!(
                f,
                "{{\"model\":\"claude-sonnet-4-6\",\"usage\":{{\"input_tokens\":1000,\"cache_read_input_tokens\":500,\"output_tokens\":200}}}}"
            )
            .unwrap();
            writeln!(
                f,
                "{{\"model\":\"claude-sonnet-4-6\",\"usage\":{{\"input_tokens\":400,\"cache_read_input_tokens\":100,\"output_tokens\":50}}}}"
            )
            .unwrap();
            write!(
                f,
                "{{\"model\":\"claude-sonnet-4-6\",\"usage\":{{\"input_tokens\":900"
            )
            .unwrap();
        }

        let count1 = tailer
            .poll_and_record(&log_path, "proj-alpha", "coder", &usage_repo)
            .unwrap();
        assert_eq!(count1, 2);
        let offset_after_1 = tailer.offset_for(&log_path);
        assert!(offset_after_1 > 0);

        // Polling again without new newlines reads 0 duplicates.
        assert_eq!(
            tailer
                .poll_and_record(&log_path, "proj-alpha", "coder", &usage_repo)
                .unwrap(),
            0
        );

        // Complete the 3rd line -> only the 3rd line is parsed!
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .unwrap();
            writeln!(f, ",\"output_tokens\":300}}}}").unwrap();
        }
        let count2 = tailer
            .poll_and_record(&log_path, "proj-alpha", "coder", &usage_repo)
            .unwrap();
        assert_eq!(count2, 1);

        // Simulate file rotation/truncation -> offset resets to 0 and parses new line cleanly.
        {
            let mut f = std::fs::File::create(&log_path).unwrap();
            writeln!(
                f,
                "{{\"model\":\"gpt-5.4\",\"usage\":{{\"prompt_tokens\":100,\"completion_tokens\":25}}}}"
            )
            .unwrap();
        }
        let count3 = tailer
            .poll_and_record(&log_path, "proj-alpha", "coder", &usage_repo)
            .unwrap();
        assert_eq!(count3, 1);

        let report = usage_repo
            .aggregate_project_usage("proj-alpha", 1, None)
            .unwrap();
        assert_eq!(report.agents.len(), 1);
        assert_eq!(report.agents[0].agent_id, "coder");
        assert_eq!(report.agents[0].input, 1000 + 400 + 900 + 100);
        assert_eq!(report.agents[0].cached, 500 + 100);
        assert_eq!(report.agents[0].output, 200 + 50 + 300 + 25);
        assert_eq!(report.agents[0].series.len(), 24);
    }
}
