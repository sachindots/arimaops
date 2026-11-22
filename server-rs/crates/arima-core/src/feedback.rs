// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Runtime mode where a previewed app dev server is running.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewMode {
    Local,
    Container,
    Sandbox,
}

/// Liveness state of a discovered dev server target.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewTargetStatus {
    Live,
    Starting,
    Stopped,
}

/// A running (or known) dev server discovered across Local, Container (`br-hq` IP), or Sandbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub id: String,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub label: String,
    pub mode: PreviewMode,
    pub port: u16,
    pub preview_url: String,
    pub status: PreviewTargetStatus,
}

/// Viewport-relative pixel bounding box captured by the DOM picker.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// DOM element context captured from `ArimaBridge` when clicking/tapping in Pick mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ElementSelection {
    pub css_selector: String,
    pub tag_name: String,
    pub aria_role: Option<String>,
    pub component_hint: Option<String>,
    pub text_snippet: String,
    pub outer_html_snippet: String,
    pub bbox: BoundingBox,
}

/// Console or network error captured automatically from the previewed page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleErrorEntry {
    pub level: String,
    pub message: String,
    pub source: Option<String>,
    pub at: String,
}

/// Where the user chose to route a visual feedback annotation on submit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FeedbackRoute {
    CreateTask {
        #[serde(rename = "boardId")]
        board_id: Option<String>,
        #[serde(rename = "taskId")]
        task_id: Option<String>,
        #[serde(rename = "assignToAgentId")]
        assign_to_agent_id: Option<String>,
    },
    SendToChat {
        #[serde(rename = "toAgentId")]
        to_agent_id: String,
        #[serde(rename = "messageId")]
        message_id: Option<String>,
    },
}

/// Complete visual feedback artifact stored on HQ and synced to `.arima/feedback/<id>/`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct VisualFeedback {
    pub id: String,
    pub project_id: String,
    pub author_user_id: String,
    pub target_id: Option<String>,
    pub source_kind: String,
    pub page_url: String,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub note: String,
    pub selection: Option<ElementSelection>,
    pub console_errors: Vec<ConsoleErrorEntry>,
    pub image_path: String,
    pub workspace_rel_dir: String,
    pub route: FeedbackRoute,
    pub created_at: String,
}
