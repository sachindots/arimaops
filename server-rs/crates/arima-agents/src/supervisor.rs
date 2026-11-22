// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use arima_core::{OutboxMessage, OutboxMessageKind};
use arima_db::{Db, DbError, OutboxRepo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::Result;

/// Lifecycle state of an agent under [`AgentSupervisor`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupervisedSessionState {
    Stopped,
    Starting,
    Running,
    Failed,
}

/// Ordered setup sequence executed inside the per-agent state lock before dispatching `"Start task"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupSequenceStep {
    WorkspaceSync,
    DeliverablePrep,
    EnvAndMcpReady,
    DispatchStartTask,
}

#[derive(Debug)]
struct AgentRuntimeSlot {
    state: SupervisedSessionState,
    desired_running: bool,
    start_generation: u64,
    completed_steps: Vec<SetupSequenceStep>,
    active_task_id: Option<String>,
    poll_loop_active: Arc<AtomicBool>,
}

impl Default for AgentRuntimeSlot {
    fn default() -> Self {
        Self {
            state: SupervisedSessionState::Stopped,
            desired_running: false,
            start_generation: 0,
            completed_steps: Vec::new(),
            active_task_id: None,
            poll_loop_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Snapshot of a supervised agent's runtime state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisedAgentSnapshot {
    pub project_id: String,
    pub agent_id: String,
    pub state: SupervisedSessionState,
    pub desired_running: bool,
    pub start_generation: u64,
    pub completed_steps: Vec<SetupSequenceStep>,
    pub active_task_id: Option<String>,
    pub poll_loop_active: bool,
}

type AgentSlotMap = HashMap<(String, String), Arc<AsyncMutex<AgentRuntimeSlot>>>;

/// Per-agent Tokio supervisor eliminating v1 concurrency races:
/// - Acquires a per-`(project_id, agent_id)` async state lock BEFORE checking/transitioning `Starting`
/// - Guarantees at most one active poll loop per agent (`poll_loop_active` atomic guard)
/// - Enforces strict async setup sequencing (`WorkspaceSync -> DeliverablePrep -> EnvAndMcpReady -> DispatchStartTask`)
/// - Persists `desired_running` intent in SQLite across HQ restarts and bumps server `epoch`.
#[derive(Debug, Clone)]
pub struct AgentSupervisor {
    db: Db,
    outbox: OutboxRepo,
    epoch: Arc<AtomicI64>,
    slots: Arc<Mutex<AgentSlotMap>>,
}

impl AgentSupervisor {
    #[must_use]
    pub fn new(db: Db, initial_epoch: i64) -> Self {
        let outbox = OutboxRepo::new(db.clone());
        Self {
            db,
            outbox,
            epoch: Arc::new(AtomicI64::new(initial_epoch.max(1))),
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[must_use]
    pub fn current_epoch(&self) -> i64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Bumps the server epoch (simulating or executing an HQ restart).
    pub fn bump_epoch(&self) -> i64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn slot_for(&self, project_id: &str, agent_id: &str) -> Arc<AsyncMutex<AgentRuntimeSlot>> {
        let mut guard = self.slots.lock().expect("supervisor slots lock");
        guard
            .entry((project_id.to_owned(), agent_id.to_owned()))
            .or_insert_with(|| Arc::new(AsyncMutex::new(AgentRuntimeSlot::default())))
            .clone()
    }

    /// Starts an agent inside its per-agent async lock, preventing concurrent `start_agent` races.
    ///
    /// If the agent is already `Starting` or `Running`, returns `Ok(false)` without spawning a
    /// duplicate session or second poll loop.
    pub async fn start_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        task_id: Option<&str>,
    ) -> Result<bool> {
        let slot_mutex = self.slot_for(project_id, agent_id);
        let mut slot = slot_mutex.lock().await;

        if matches!(
            slot.state,
            SupervisedSessionState::Starting | SupervisedSessionState::Running
        ) {
            return Ok(false);
        }

        // Transition to Starting BEFORE any async setup step while holding the per-agent lock.
        slot.state = SupervisedSessionState::Starting;
        slot.desired_running = true;
        slot.start_generation += 1;
        slot.completed_steps.clear();
        slot.active_task_id = task_id.map(str::to_owned);

        self.persist_desired_running(project_id, agent_id, true)?;

        // Execute strict setup sequence in order before dispatching "Start task".
        tokio::task::yield_now().await;
        slot.completed_steps.push(SetupSequenceStep::WorkspaceSync);

        tokio::task::yield_now().await;
        slot.completed_steps
            .push(SetupSequenceStep::DeliverablePrep);

        tokio::task::yield_now().await;
        slot.completed_steps.push(SetupSequenceStep::EnvAndMcpReady);

        if let Some(tid) = task_id {
            let payload = json!({
                "action": "Start task",
                "taskId": tid,
                "generation": slot.start_generation,
            })
            .to_string();
            self.outbox.enqueue(
                project_id,
                agent_id,
                self.current_epoch(),
                OutboxMessageKind::Text,
                &payload,
            )?;
        }
        slot.completed_steps
            .push(SetupSequenceStep::DispatchStartTask);

        // Ensure at most one poll loop is marked active.
        let _already_polling = slot
            .poll_loop_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);

        slot.state = SupervisedSessionState::Running;
        Ok(true)
    }

    /// Stops a supervised agent, clearing its `poll_loop_active` guard and persisted desired state.
    pub async fn stop_agent(&self, project_id: &str, agent_id: &str) -> Result<bool> {
        let slot_mutex = self.slot_for(project_id, agent_id);
        let mut slot = slot_mutex.lock().await;

        let was_active = !matches!(slot.state, SupervisedSessionState::Stopped);
        slot.state = SupervisedSessionState::Stopped;
        slot.desired_running = false;
        slot.poll_loop_active.store(false, Ordering::SeqCst);

        self.persist_desired_running(project_id, agent_id, false)?;
        Ok(was_active)
    }

    /// Returns a snapshot of `(project_id, agent_id)` runtime state.
    pub async fn snapshot(&self, project_id: &str, agent_id: &str) -> SupervisedAgentSnapshot {
        let slot_mutex = self.slot_for(project_id, agent_id);
        let slot = slot_mutex.lock().await;
        SupervisedAgentSnapshot {
            project_id: project_id.to_owned(),
            agent_id: agent_id.to_owned(),
            state: slot.state,
            desired_running: slot.desired_running,
            start_generation: slot.start_generation,
            completed_steps: slot.completed_steps.clone(),
            active_task_id: slot.active_task_id.clone(),
            poll_loop_active: slot.poll_loop_active.load(Ordering::SeqCst),
        }
    }

    /// Enqueues a message for `(project_id, agent_id)` under the supervisor's current epoch.
    pub fn enqueue_outbox(
        &self,
        project_id: &str,
        agent_id: &str,
        kind: OutboxMessageKind,
        payload_json: &str,
    ) -> Result<OutboxMessage> {
        Ok(self.outbox.enqueue(
            project_id,
            agent_id,
            self.current_epoch(),
            kind,
            payload_json,
        )?)
    }

    /// Polls the next pending outbox item for `(project_id, agent_id)`.
    pub fn poll_next_outbox(
        &self,
        project_id: &str,
        agent_id: &str,
        client_epoch: i64,
        client_ack: i64,
    ) -> Result<Option<OutboxMessage>> {
        Ok(self.outbox.next_pending(
            project_id,
            agent_id,
            self.current_epoch(),
            client_epoch,
            client_ack,
        )?)
    }

    /// Reads persisted desired-running agents for `project_id` from `projects.config_json`
    /// and resumes them cleanly without overlapping poll loops.
    pub async fn resume_desired_agents(&self, project_id: &str) -> Result<Vec<String>> {
        let desired = self.load_desired_running(project_id)?;
        let mut resumed = Vec::new();
        for agent_id in desired {
            if self.start_agent(project_id, &agent_id, None).await? {
                resumed.push(agent_id);
            }
        }
        Ok(resumed)
    }

    fn persist_desired_running(
        &self,
        project_id: &str,
        agent_id: &str,
        desired: bool,
    ) -> Result<()> {
        self.db.transaction(|conn| {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw_json) = raw else {
                return Ok::<_, DbError>(());
            };
            let mut root: Value = serde_json::from_str(&raw_json).unwrap_or_else(|_| json!({}));
            if !root.is_object() {
                root = json!({});
            }
            let obj = root.as_object_mut().expect("object");
            let mut list: Vec<String> = obj
                .get("desiredRunningAgents")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();

            list.retain(|x| x != agent_id);
            if desired {
                list.push(agent_id.to_owned());
            }
            obj.insert("desiredRunningAgents".into(), json!(list));

            conn.execute(
                "UPDATE projects SET config_json = ?1 WHERE id = ?2",
                rusqlite::params![root.to_string(), project_id],
            )?;
            Ok::<_, DbError>(())
        })?;
        Ok(())
    }

    pub fn load_desired_running(&self, project_id: &str) -> Result<Vec<String>> {
        let list = self.db.read(|conn| {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw_json) = raw else {
                return Ok::<_, DbError>(Vec::new());
            };
            let root: Value = serde_json::from_str(&raw_json).unwrap_or_else(|_| json!({}));
            let out: Vec<String> = root
                .get("desiredRunningAgents")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            Ok::<_, DbError>(out)
        })?;
        Ok(list)
    }
}
