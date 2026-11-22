// SPDX-License-Identifier: AGPL-3.0-or-later

//! The agent runtime against a real Docker daemon. Skips itself where Docker (daemon and CLI) isn't available.
//! The agent's CLI is a script named `opencode` that runs `cat`, so what is typed into the terminal comes straight back.

use std::process::{Command, Stdio};
use std::time::Duration;

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::team::{self};
use arima_server::team_edit as edit;
use arima_server::{AppState, ServerConfig};
use serde_json::json;

fn docker(args: &[&str], stdin: Option<&str>) -> bool {
    let mut child = match Command::new("docker").args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        use std::io::Write;
        let _ = pipe.write_all(text.as_bytes());
    }
    child.wait().is_ok_and(|s| s.success())
}

#[tokio::test]
async fn an_agent_runs_in_a_container_and_its_terminal_round_trips() {
    if !docker(&["version"], None) {
        eprintln!("no Docker: skipping");
        return;
    }
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let image = format!("arima-rt-test-agent:{tag}");
    let network = format!("arima-rt-test-{tag}");
    assert!(docker(&["build", "-t", &image, "-"], Some("FROM busybox:1.36\nRUN printf '#!/bin/sh\\nexec cat\\n' > /bin/opencode && chmod +x /bin/opencode\n")), "the test image builds");
    let root = tempfile::TempDir::new().unwrap();
    // SAFETY: this test binary has one test and sets these before any other thread reads the environment.
    unsafe {
        std::env::set_var("ARIMA_AGENT_IMAGE", &image);
        std::env::set_var("ARIMA_AGENT_NETWORK", &network);
        std::env::set_var("ARIMA_WORKSPACES_ROOT", root.path());
    }
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([3u8; 32]), ServerConfig::default());
    assert!(state.inner.runtime.config.enabled, "the daemon socket exists");
    state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
    let pid = state.default_project().unwrap().0;

    assert!(state.inner.runtime.start(&state, &pid, "cipher").await.is_err(), "no team yet");
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    assert!(team::load(&state, &pid).unwrap().team.iter().all(|a| a["mode"] == "container"), "new teams default to container mode when Docker is reachable");
    edit::update_role(&state, &pid, &[json!("lead"), json!({ "cli": "opencode" })]).unwrap();
    edit::set_team_mode(&state, &pid, &[json!("local")]).unwrap();
    let err = state.inner.runtime.start(&state, &pid, "cipher").await.unwrap_err();
    assert!(err.contains("container mode"), "{err}");
    edit::set_team_mode(&state, &pid, &[json!("container")]).unwrap();

    state.inner.runtime.start(&state, &pid, "cipher").await.unwrap();
    assert!(state.inner.runtime.is_running(&pid, "cipher"));
    state.inner.runtime.start(&state, &pid, "cipher").await.unwrap();
    state.inner.runtime.send_input(&pid, "cipher", "echo-me-42\n").await.unwrap();
    let mut seen = String::new();
    for _ in 0..40 {
        seen = state.inner.runtime.scrollbacks(&pid).into_iter().map(|(_, d)| d).collect();
        if seen.contains("echo-me-42") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(seen.contains("echo-me-42"), "the typed line came back through the terminal: {seen:?}");
    state.inner.runtime.resize(&pid, "cipher", 100, 30).await.unwrap();

    arima_server::delivery::send_from_owner(&state, &pid, "lead", "please review the plan").await.unwrap();
    let mut seen = String::new();
    for _ in 0..40 {
        seen = state.inner.runtime.scrollbacks(&pid).into_iter().map(|(_, d)| d).collect();
        if seen.contains("Message from the owner: please review the plan") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(seen.contains("Message from the owner: please review the plan"), "the owner's chat message is typed into the running agent: {seen:?}");
    assert_eq!(state.inner.supervisor.poll_next_outbox(&pid, "cipher", 0, 0).unwrap().map(|m| m.seq), None, "a typed message is acknowledged");

    let snap = arima_server::ws::build_initial_snapshot(&state, Some(&pid));
    let cipher = snap["snapshot"]["agents"].as_array().unwrap().iter().find(|a| a["agentId"] == "cipher").unwrap();
    assert_eq!(cipher["session"]["state"], "running");
    let workspace = root.path().join("demo").join("cipher");
    assert!(workspace.join("AGENTS.md").is_file(), "the agent's role file is written into its folder");
    assert!(state.inner.runtime.send_input(&pid, "zero", "x").await.is_err(), "a stopped agent takes no input");

    state.inner.runtime.stop(&state, &pid, "cipher").await.unwrap();
    assert!(!state.inner.runtime.is_running(&pid, "cipher"));
    let snap = arima_server::ws::build_initial_snapshot(&state, Some(&pid));
    assert_eq!(snap["snapshot"]["agents"][0]["session"]["state"], "stopped");
    assert!(!docker(&["inspect", "hq-demo-cipher"], None), "the container is removed");

    // An agent that ends its own session (Ctrl-D closes `cat`) is cleaned up without a stop command.
    state.inner.runtime.start(&state, &pid, "cipher").await.unwrap();
    state.inner.runtime.send_input(&pid, "cipher", "\u{4}").await.unwrap();
    for _ in 0..40 {
        if !state.inner.runtime.is_running(&pid, "cipher") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(!state.inner.runtime.is_running(&pid, "cipher"), "a session that ends on its own is cleaned up");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!docker(&["inspect", "hq-demo-cipher"], None), "its container is removed too");

    docker(&["network", "rm", &network], None);
    docker(&["rmi", "-f", &image], None);
}
