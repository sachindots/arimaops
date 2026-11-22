// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use arima_core::{
    DecisionPayload, DecisionStatus, PermissionPayload, ServerRole, VisualDecision,
};
use arima_db::{DecisionsRepo, ResolveDecisionInput};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{Result, ShimError};

/// Structured permission verdict returned to `--permission-prompt-tool`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionVerdict {
    AllowOnce,
    AllowForTask,
    Deny,
}

impl PermissionVerdict {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow-once",
            Self::AllowForTask => "allow-for-task",
            Self::Deny => "deny",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "allow-once" | "allowonce" | "once" | "allow" | "done" | "resolved" => {
                Some(Self::AllowOnce)
            }
            "allow-for-task" | "allowfortask" | "task" | "always" => Some(Self::AllowForTask),
            "deny" | "denied" | "dismiss" | "dismissed" | "reject" => Some(Self::Deny),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowForTask)
    }
}

/// Incoming JSON payload from a CLI agent's `--permission-prompt-tool` hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionHookRequest {
    pub tool_name: String,
    pub command_or_path: String,
    pub reason: String,
    #[serde(default)]
    pub scope_hint: Option<String>,
}

/// Outgoing JSON response written back to `--permission-prompt-tool` stdout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionHookResponse {
    pub allow: bool,
    pub decision: PermissionVerdict,
    pub decision_id: String,
    #[serde(default)]
    pub note: Option<String>,
}

/// Pending permission request sent from `arima-shim` to HQ.
pub struct PendingPermissionPrompt {
    pub decision: VisualDecision,
    pub responder: oneshot::Sender<(PermissionVerdict, Option<String>)>,
}

/// `--permission-prompt-tool` interceptor that emits structured [`PermissionPayload`] visual
/// decisions to HQ and blocks cleanly until `AllowOnce`, `AllowForTask`, or `Deny` arrives.
#[derive(Debug, Clone)]
pub struct PermissionInterceptor {
    project_id: String,
    agent_id: String,
    task_id: Option<String>,
    task_allowlist: Arc<Mutex<HashSet<(String, String)>>>,
}

impl PermissionInterceptor {
    #[must_use]
    pub fn new(
        project_id: impl Into<String>,
        agent_id: impl Into<String>,
        task_id: Option<String>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            agent_id: agent_id.into(),
            task_id,
            task_allowlist: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn cache_key(req: &PermissionHookRequest) -> (String, String) {
        let scope = req
            .scope_hint
            .clone()
            .unwrap_or_else(|| req.command_or_path.clone());
        (req.tool_name.clone(), scope)
    }

    /// Builds a [`VisualDecision`] with [`DecisionPayload::Permission`] for HQ Inbox and Chat.
    #[must_use]
    pub fn build_visual_decision(&self, req: &PermissionHookRequest) -> VisualDecision {
        let id = format!("perm-{}", uuid::Uuid::new_v4().simple());
        VisualDecision {
            id,
            project_id: self.project_id.clone(),
            from_id: self.agent_id.clone(),
            task_id: self.task_id.clone(),
            title: format!("Allow {} on `{}`?", req.tool_name, req.command_or_path),
            details: req.reason.clone(),
            waiting: true,
            owner_only: false,
            status: DecisionStatus::Open,
            payload: DecisionPayload::Permission(PermissionPayload {
                tool_name: req.tool_name.clone(),
                command_or_path: req.command_or_path.clone(),
                reason: req.reason.clone(),
                scope_hint: req.scope_hint.clone(),
                resolution: None,
            }),
            note: None,
            created_at: Utc::now().to_rfc3339(),
            closed_at: None,
        }
    }

    /// Requests permission via an async channel to HQ and blocks until the user clicks
    /// `Allow once`, `Allow for task`, or `Deny` on the `PermissionCard`.
    ///
    /// If the user previously selected `AllowForTask` for the same `(tool_name, scope)`,
    /// immediately returns `AllowForTask` without re-prompting.
    pub async fn request_permission(
        &self,
        req: PermissionHookRequest,
        prompt_tx: &tokio::sync::mpsc::Sender<PendingPermissionPrompt>,
    ) -> Result<PermissionHookResponse> {
        let key = Self::cache_key(&req);
        if let Ok(guard) = self.task_allowlist.lock() {
            if guard.contains(&key) {
                return Ok(PermissionHookResponse {
                    allow: true,
                    decision: PermissionVerdict::AllowForTask,
                    decision_id: "cached-task-allow".into(),
                    note: Some("auto-approved by prior AllowForTask".into()),
                });
            }
        }

        let decision = self.build_visual_decision(&req);
        let decision_id = decision.id.clone();
        let (tx, rx) = oneshot::channel();

        prompt_tx
            .send(PendingPermissionPrompt {
                decision,
                responder: tx,
            })
            .await
            .map_err(|_| ShimError::Protocol("permission prompt channel closed".into()))?;

        let (verdict, note) = rx
            .await
            .map_err(|_| ShimError::Protocol("permission prompt responder dropped".into()))?;

        if verdict == PermissionVerdict::AllowForTask {
            if let Ok(mut guard) = self.task_allowlist.lock() {
                guard.insert(key);
            }
        }

        Ok(PermissionHookResponse {
            allow: verdict.is_allowed(),
            decision: verdict,
            decision_id,
            note,
        })
    }

    /// Persists the permission prompt directly into [`DecisionsRepo`] and resolves it when
    /// `verdict` is supplied, returning the updated [`VisualDecision`] and [`PermissionHookResponse`].
    pub fn persist_and_resolve_with_repo(
        &self,
        repo: &DecisionsRepo,
        req: &PermissionHookRequest,
        verdict: PermissionVerdict,
        actor_role: ServerRole,
        note: Option<String>,
    ) -> Result<(VisualDecision, PermissionHookResponse)> {
        let decision = self.build_visual_decision(req);
        repo.upsert(&decision)
            .map_err(|e| ShimError::Protocol(e.to_string()))?;

        let status = if verdict.is_allowed() {
            DecisionStatus::Resolved
        } else {
            DecisionStatus::Dismissed
        };

        let resolved = repo
            .resolve(
                &decision.id,
                ResolveDecisionInput {
                    status: Some(status),
                    answers: None,
                    chosen_side: None,
                    permission_resolution: Some(verdict.as_str().to_owned()),
                    note: note.clone(),
                },
                actor_role,
            )
            .map_err(|e| ShimError::Protocol(e.to_string()))?;

        if verdict == PermissionVerdict::AllowForTask {
            if let Ok(mut guard) = self.task_allowlist.lock() {
                guard.insert(Self::cache_key(req));
            }
        }

        let resp = PermissionHookResponse {
            allow: verdict.is_allowed(),
            decision: verdict,
            decision_id: resolved.id.clone(),
            note,
        };
        Ok((resolved, resp))
    }
}

/// Evaluates a raw JSON `--permission-prompt-tool` stdin payload with a default verdict.
pub fn evaluate_stdio_hook_json(
    raw_input: &str,
    verdict: PermissionVerdict,
) -> Result<String> {
    let req: PermissionHookRequest = serde_json::from_str(raw_input)?;
    let resp = PermissionHookResponse {
        allow: verdict.is_allowed(),
        decision: verdict,
        decision_id: format!("perm-{}", uuid::Uuid::new_v4().simple()),
        note: Some(format!("handled for tool {}", req.tool_name)),
    };
    Ok(serde_json::to_string(&resp)?)
}
