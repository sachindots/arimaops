// SPDX-License-Identifier: AGPL-3.0-or-later

//! A small Docker Engine API client over the Unix socket.
//!
//! It covers what the agent runtime needs: create, start, stop, remove, inspect, resize, image pulls and a
//! hijacked TTY attach. Requests are HTTP/1.0 with `Connection: close`, so replies are plain bodies read to the
//! end (the daemon never chunks them). Attach upgrades the connection to a raw duplex stream.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::{AgentError, Result};

pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";

fn engine_err(msg: impl Into<String>) -> AgentError {
    AgentError::Engine(msg.into())
}

/// What the daemon reports about a container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerState {
    pub running: bool,
    pub status: String,
    pub exit_code: i64,
}

#[derive(Debug, Clone)]
pub struct DockerEngine {
    socket: PathBuf,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn message(&self) -> String {
        self.json()["message"].as_str().map_or_else(|| String::from_utf8_lossy(&self.body).trim().to_owned(), str::to_owned)
    }
}

impl DockerEngine {
    #[must_use]
    pub fn new(socket: impl AsRef<Path>) -> Self {
        Self { socket: socket.as_ref().to_path_buf() }
    }

    /// Uses `DOCKER_HOST=unix://…` when set, else the default socket.
    #[must_use]
    pub fn from_env() -> Self {
        let path = std::env::var("DOCKER_HOST").ok().and_then(|h| h.strip_prefix("unix://").map(str::to_owned)).unwrap_or_else(|| DEFAULT_SOCKET.to_owned());
        Self::new(path)
    }

    fn request_bytes(method: &str, path: &str, body: Option<&Value>) -> Vec<u8> {
        let payload = body.map(Value::to_string).unwrap_or_default();
        let mut head = format!("{method} {path} HTTP/1.0\r\nHost: docker\r\nConnection: close\r\n");
        if body.is_some() {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(payload.as_bytes());
        out
    }

    async fn send(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Reply> {
        let mut stream = UnixStream::connect(&self.socket).await.map_err(|e| engine_err(format!("can't reach Docker at {}: {e}", self.socket.display())))?;
        stream.write_all(&Self::request_bytes(method, path, body)).await?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| engine_err("malformed reply from Docker"))?;
        let head = String::from_utf8_lossy(&raw[..split]);
        let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| engine_err("malformed status line from Docker"))?;
        Ok(Reply { status, body: raw[split + 4..].to_vec() })
    }

    async fn expect(&self, method: &str, path: &str, body: Option<&Value>, ok: &[u16]) -> Result<Reply> {
        let reply = self.send(method, path, body).await?;
        if ok.contains(&reply.status) {
            Ok(reply)
        } else {
            Err(engine_err(format!("Docker answered {} for {method} {path}: {}", reply.status, reply.message())))
        }
    }

    pub async fn ping(&self) -> Result<()> {
        self.expect("GET", "/_ping", None, &[200]).await.map(|_| ())
    }

    pub async fn image_present(&self, image: &str) -> Result<bool> {
        let reply = self.send("GET", &format!("/images/{}/json", encode(image)), None).await?;
        match reply.status {
            200 => Ok(true),
            404 => Ok(false),
            s => Err(engine_err(format!("Docker answered {s} checking image {image}: {}", reply.message()))),
        }
    }

    /// Pulls `image` (`repo[:tag]`) and waits for the daemon to finish.
    pub async fn pull_image(&self, image: &str) -> Result<()> {
        let (repo, tag) = image.rsplit_once(':').filter(|(_, t)| !t.contains('/')).unwrap_or((image, "latest"));
        let reply = self.expect("POST", &format!("/images/create?fromImage={}&tag={}", encode(repo), encode(tag)), None, &[200]).await?;
        let failed = String::from_utf8_lossy(&reply.body).lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|v| v["error"].as_str().map(str::to_owned));
        failed.map_or(Ok(()), |e| Err(engine_err(format!("couldn't pull {image}: {e}"))))
    }

    pub async fn ensure_image(&self, image: &str) -> Result<()> {
        if self.image_present(image).await? { Ok(()) } else { self.pull_image(image).await }
    }

    pub async fn ensure_network(&self, name: &str) -> Result<()> {
        let reply = self.send("GET", &format!("/networks/{}", encode(name)), None).await?;
        match reply.status {
            200 => Ok(()),
            404 => self.expect("POST", "/networks/create", Some(&json!({ "Name": name, "Driver": "bridge", "CheckDuplicate": true })), &[201]).await.map(|_| ()),
            s => Err(engine_err(format!("Docker answered {s} checking network {name}: {}", reply.message()))),
        }
    }

    /// Creates a container from a Docker create body and returns its id.
    pub async fn create_container(&self, name: &str, body: &Value) -> Result<String> {
        let reply = self.expect("POST", &format!("/containers/create?name={}", encode(name)), Some(body), &[201]).await?;
        reply.json()["Id"].as_str().map(str::to_owned).ok_or_else(|| engine_err("Docker returned no container id"))
    }

    pub async fn start(&self, id: &str) -> Result<()> {
        self.expect("POST", &format!("/containers/{}/start", encode(id)), None, &[204, 304]).await.map(|_| ())
    }

    /// Stops a container, giving it `grace_secs` before the kill. A container that is already gone counts as stopped.
    pub async fn stop(&self, id: &str, grace_secs: u32) -> Result<()> {
        let reply = self.send("POST", &format!("/containers/{}/stop?t={grace_secs}", encode(id)), None).await?;
        match reply.status {
            204 | 304 | 404 => Ok(()),
            s => Err(engine_err(format!("Docker answered {s} stopping {id}: {}", reply.message()))),
        }
    }

    /// Removes a container by id or name. A missing container is fine.
    pub async fn remove(&self, id: &str) -> Result<()> {
        let reply = self.send("DELETE", &format!("/containers/{}?force=1&v=1", encode(id)), None).await?;
        match reply.status {
            204 | 404 => Ok(()),
            409 if reply.message().contains("already in progress") => Ok(()),
            s => Err(engine_err(format!("Docker answered {s} removing {id}: {}", reply.message()))),
        }
    }

    pub async fn inspect(&self, id: &str) -> Result<Option<ContainerState>> {
        let reply = self.send("GET", &format!("/containers/{}/json", encode(id)), None).await?;
        match reply.status {
            200 => {
                let v = reply.json();
                Ok(Some(ContainerState {
                    running: v["State"]["Running"].as_bool().unwrap_or(false),
                    status: v["State"]["Status"].as_str().unwrap_or("").to_owned(),
                    exit_code: v["State"]["ExitCode"].as_i64().unwrap_or(0),
                }))
            }
            404 => Ok(None),
            s => Err(engine_err(format!("Docker answered {s} inspecting {id}: {}", reply.message()))),
        }
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.expect("POST", &format!("/containers/{}/resize?h={rows}&w={cols}", encode(id)), None, &[200]).await.map(|_| ())
    }

    /// Attaches to a container's TTY. The returned stream is raw: bytes written go to the program's stdin, bytes read
    /// are its terminal output. Call after `start`, or output printed before attaching is lost (use `logs` for that).
    pub async fn attach(&self, id: &str) -> Result<UnixStream> {
        let mut stream = UnixStream::connect(&self.socket).await.map_err(|e| engine_err(format!("can't reach Docker at {}: {e}", self.socket.display())))?;
        let req = format!(
            "POST /containers/{}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n",
            encode(id)
        );
        stream.write_all(req.as_bytes()).await?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await? == 0 || head.len() > 8192 {
                return Err(engine_err("Docker closed the attach connection"));
            }
            head.push(byte[0]);
        }
        let status = String::from_utf8_lossy(&head).split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        if status != 101 && status != 200 {
            return Err(engine_err(format!("Docker answered {status} attaching to {id}")));
        }
        Ok(stream)
    }
}

/// Percent-encodes everything outside the unreserved set, so names and references are safe in a path or query.
fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b':') { char::from(b).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_keeps_references_readable_and_escapes_the_rest() {
        assert_eq!(encode("hq-demo_agent.1"), "hq-demo_agent.1");
        assert_eq!(encode("ghcr.io/a/b"), "ghcr.io%2Fa%2Fb");
        assert_eq!(encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn requests_are_http10_with_a_json_body_when_given() {
        let req = String::from_utf8(DockerEngine::request_bytes("POST", "/x", Some(&json!({ "a": 1 })))).unwrap();
        assert!(req.starts_with("POST /x HTTP/1.0\r\n") && req.contains("Content-Length: 7\r\n") && req.ends_with("{\"a\":1}"));
        assert!(!String::from_utf8(DockerEngine::request_bytes("GET", "/y", None)).unwrap().contains("Content-Length"));
    }

    /// Runs only where a Docker daemon is reachable. Starts `cat` in a TTY, types into it and reads it back.
    #[tokio::test]
    async fn live_daemon_round_trip_through_attach() {
        let engine = DockerEngine::from_env();
        if engine.ping().await.is_err() {
            eprintln!("no Docker daemon: skipping");
            return;
        }
        let image = "busybox:1.36";
        engine.ensure_image(image).await.unwrap();
        let name = format!("arima-engine-test-{}", uuid::Uuid::new_v4().simple());
        let body = json!({ "Image": image, "Cmd": ["cat"], "Tty": true, "OpenStdin": true, "HostConfig": { "AutoRemove": false, "Memory": 64 * 1024 * 1024 } });
        let id = engine.create_container(&name, &body).await.unwrap();
        engine.start(&id).await.unwrap();
        let mut io = engine.attach(&id).await.unwrap();
        engine.resize(&id, 100, 30).await.unwrap();
        io.write_all(b"hello-agent\n").await.unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 256];
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !String::from_utf8_lossy(&seen).contains("hello-agent") && tokio::time::Instant::now() < deadline {
            if let Ok(Ok(n)) = tokio::time::timeout(std::time::Duration::from_millis(500), io.read(&mut buf)).await {
                seen.extend_from_slice(&buf[..n]);
            }
        }
        assert!(String::from_utf8_lossy(&seen).contains("hello-agent"), "the program's output came back through the TTY");
        assert!(engine.inspect(&id).await.unwrap().unwrap().running);
        engine.stop(&id, 1).await.unwrap();
        assert!(!engine.inspect(&id).await.unwrap().unwrap().running);
        engine.remove(&name).await.unwrap();
        assert!(engine.inspect(&id).await.unwrap().is_none(), "removed containers are gone");
        engine.remove(&name).await.unwrap();
    }
}
