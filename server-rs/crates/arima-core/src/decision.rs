// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::form::{Form, FormAnswer, FormPayload, FormSpec};
use crate::meeting::{MeetingKind, MeetingUrgency};
use crate::pack::{PackAgent, PackChange, PackFileSummary};

/// Lifecycle state of a visual decision shown in Inbox and inline Chat.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionStatus {
    Open,
    Resolved,
    Dismissed,
}

/// Exhaustive classification of agent-to-user visual decisions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionKind {
    Question,
    SecondOpinion,
    Disagreement,
    Permission,
    MeetingRequest,
    MemoryReview,
    SkillScan,
    PackReview,
    Info,
    Form,
}

/// One selectable option inside a structured `ask_user` prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

/// A single structured question asked by an agent (single-select or multi-select).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPrompt {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub allow_other: bool,
    pub options: Vec<QuestionOption>,
}

/// User's visual answer to one `QuestionPrompt`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    #[serde(default)]
    pub other_text: Option<String>,
}

/// Payload for structured multi-choice `ask_user` cards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPayload {
    pub questions: Vec<QuestionPrompt>,
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
}

/// One position in a second-opinion review or agent-vs-agent disagreement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpinionSide {
    pub label: String,
    pub author_id: String,
    pub summary: String,
    pub rationale_markdown: String,
    #[serde(default)]
    pub risks: Vec<String>,
}

/// Payload for side-by-side Second-Opinion and escalated Disagreement cards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecondOpinionPayload {
    pub task_id: Option<String>,
    pub gate_id: Option<String>,
    pub recommendation: Option<String>,
    pub confidence: Option<String>,
    pub option_a: OpinionSide,
    pub option_b: OpinionSide,
    pub can_waive_gate: bool,
    pub chosen_side: Option<String>,
}

/// Payload for visual CLI / `--permission-prompt-tool` / trust prompts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPayload {
    pub tool_name: String,
    pub command_or_path: String,
    pub reason: String,
    pub scope_hint: Option<String>,
    pub resolution: Option<String>,
}

/// Discriminated union carrying kind-specific metadata for any visual decision card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DecisionPayload {
    Question(QuestionPayload),
    SecondOpinion(SecondOpinionPayload),
    Disagreement(SecondOpinionPayload),
    Permission(PermissionPayload),
    MeetingRequest {
        #[serde(rename = "meetingId")]
        meeting_id: String,
        #[serde(rename = "meetingKind")]
        meeting_kind: MeetingKind,
        urgency: MeetingUrgency,
        #[serde(rename = "participantIds")]
        participant_ids: Vec<String>,
        #[serde(rename = "agendaPreview")]
        agenda_preview: Vec<String>,
    },
    MemoryReview {
        memories: Value,
    },
    SkillScan {
        pack: String,
        findings: Vec<String>,
    },
    /// A pack to install, or a change to an installed one (new commit or a server's live tool list).
    PackReview {
        pack: String,
        /// The approved commit; none on first install.
        from: Option<String>,
        to: String,
        /// Tree hash of the approved pack; none on first install. Used to fetch collapsed file diffs on demand.
        #[serde(default, rename = "fromTree")]
        from_tree: Option<String>,
        /// Tree hash of the pack under review. Used to fetch collapsed file diffs on demand.
        #[serde(default, rename = "toTree")]
        to_tree: String,
        changed: Vec<PackChange>,
        /// Changed shipped files other than SKILL.md and agents/*.md, shown collapsed.
        #[serde(default, rename = "otherFiles")]
        other_files: Vec<PackFileSummary>,
        /// Sub-agents discovered under `agents/*.md` and registered with a whitelisted set of fields.
        #[serde(default)]
        agents: Vec<PackAgent>,
        egress: Vec<String>,
        secrets: Vec<String>,
        ignored: Vec<String>,
        /// Scan findings, blocking ones first.
        findings: Vec<String>,
        /// The roles that get the pack's skills on approval: the default when the card is filed, then the owner's
        /// answer (a `roles` question answer).
        #[serde(default)]
        roles: Vec<String>,
    },
    Info {
        markdown: String,
    },
    /// An agent form: a checked component list the Inbox renders, and the owner's answer.
    Form(FormPayload),
}

/// Contextual labels supplied by HQ when synthesizing a [`FormSpec`] for a [`DecisionPayload`].
#[derive(Debug, Clone, Default)]
pub struct DecisionFormContext {
    /// `(role_id, role_title)` pairs used by `PackReview` role check lists.
    pub role_options: Vec<(String, String)>,
    /// Optional agent id -> display name lookup for `SecondOpinion` and `MeetingRequest`.
    pub team_names: HashMap<String, String>,
}

fn trunc(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn side_markdown(heading: &str, side: &OpinionSide, who: &str) -> String {
    let mut out = format!("### {heading}: {} ({who})\n\n{}", side.label, side.summary);
    let rationale = side.rationale_markdown.trim();
    if !rationale.is_empty() {
        out.push_str("\n\n");
        out.push_str(&trunc(rationale, 2_400));
    }
    if !side.risks.is_empty() {
        out.push_str("\n\n**Risks to watch:**");
        for r in side.risks.iter().take(8) {
            out.push_str("\n- ");
            out.push_str(&trunc(r, 240));
        }
    }
    trunc(&out, 7_500)
}

impl DecisionPayload {
    /// Synthesizes the validated A2UI v1.0 [`FormSpec`] rendered by the Inbox and inline Chat cards.
    #[must_use]
    pub fn build_form(&self, ctx: &DecisionFormContext) -> FormSpec {
        match self {
            Self::Form(f) => f.form.clone(),
            Self::Permission(p) => {
                let mut rows = vec![("Tool", trunc(&p.tool_name, 200))];
                if let Some(ref scope) = p.scope_hint {
                    if !scope.trim().is_empty() {
                        rows.push(("Scope", trunc(scope, 400)));
                    }
                }
                let mut f = Form::new().key_values(
                    &rows.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>(),
                );
                f = f.code(None, &trunc(&p.command_or_path, 7_500));
                if !p.reason.trim().is_empty() {
                    f = f.text(&trunc(&p.reason, 1_800), None);
                }
                f.text_field("Note", "note", Some("Optional note…"), false, "")
                    .buttons(&[
                        ("allow-once", "Allow once", true),
                        ("allow-task", "Allow for task", false),
                        ("deny", "Deny", false),
                    ])
                    .build()
            }
            Self::SecondOpinion(so) | Self::Disagreement(so) => {
                let mut meta: Vec<(&str, String)> = Vec::new();
                if let Some(ref rec) = so.recommendation {
                    if !rec.trim().is_empty() {
                        meta.push(("Recommendation", trunc(rec, 600)));
                    }
                }
                if let Some(ref conf) = so.confidence {
                    if !conf.trim().is_empty() {
                        meta.push(("Confidence", trunc(conf, 200)));
                    }
                }
                if let Some(ref task) = so.task_id {
                    meta.push(("Task", trunc(task, 100)));
                }
                if let Some(ref gate) = so.gate_id {
                    meta.push(("Gate", trunc(gate, 100)));
                }
                let mut f = Form::new();
                if !meta.is_empty() {
                    let borrowed: Vec<(&str, &str)> = meta.iter().map(|(k, v)| (*k, v.as_str())).collect();
                    f = f.key_values(&borrowed);
                }
                let who_a = ctx.team_names.get(&so.option_a.author_id).map_or(so.option_a.author_id.as_str(), String::as_str);
                let who_b = ctx.team_names.get(&so.option_b.author_id).map_or(so.option_b.author_id.as_str(), String::as_str);
                f = f
                    .markdown(&side_markdown("Option A", &so.option_a, who_a))
                    .markdown(&side_markdown("Option B", &so.option_b, who_b))
                    .text_field("Note", "note", Some("Rationale or instructions for the team (optional)…"), false, "");
                let mut btns = vec![
                    ("optionA", "Pick Option A", true),
                    ("optionB", "Pick Option B", true),
                    ("revise", "Ask to Revise", false),
                ];
                if so.can_waive_gate {
                    btns.push(("waive", "Waive Gate", false));
                }
                f.buttons(&btns).build()
            }
            Self::MeetingRequest { meeting_kind, urgency, participant_ids, agenda_preview, .. } => {
                let kind_label = match meeting_kind {
                    MeetingKind::Standup => "Standup",
                    MeetingKind::Review => "Review",
                    MeetingKind::Discussion => "Discussion",
                    MeetingKind::Kickoff => "Kickoff",
                };
                let urgency_label = match urgency {
                    MeetingUrgency::Low => "Low",
                    MeetingUrgency::Normal => "Normal",
                    MeetingUrgency::High => "High",
                };
                let participants: Vec<String> = participant_ids
                    .iter()
                    .take(12)
                    .map(|id| ctx.team_names.get(id).cloned().unwrap_or_else(|| id.clone()))
                    .collect();
                let mut rows = vec![("Kind", kind_label.to_owned()), ("Urgency", urgency_label.to_owned())];
                if !participants.is_empty() {
                    rows.push(("Participants", trunc(&participants.join(", "), 600)));
                }
                let borrowed: Vec<(&str, &str)> = rows.iter().map(|(k, v)| (*k, v.as_str())).collect();
                let mut f = Form::new().key_values(&borrowed);
                if !agenda_preview.is_empty() {
                    let bullets: Vec<String> = agenda_preview.iter().take(12).map(|item| format!("- {}", trunc(item, 400))).collect();
                    f = f.markdown(&format!("### Agenda\n{}", bullets.join("\n")));
                }
                f.buttons(&[
                    ("join", "Join now", true),
                    ("snooze", "Snooze", false),
                    ("decline", "Decline", false),
                ])
                .build()
            }
            Self::Question(q) => {
                let mut f = Form::new();
                for prompt in &q.questions {
                    if prompt.options.is_empty() {
                        continue;
                    }
                    let opts_owned: Vec<(String, String, Option<String>)> = prompt
                        .options
                        .iter()
                        .map(|o| {
                            let label = if o.recommended {
                                format!("{} (Recommended)", trunc(&o.label, 1_700))
                            } else {
                                trunc(&o.label, 1_800)
                            };
                            (o.id.clone(), label, o.description.as_deref().map(|d| trunc(d, 1_800)))
                        })
                        .collect();
                    let opts_ref: Vec<(&str, &str, Option<&str>)> = opts_owned
                        .iter()
                        .map(|(v, l, d)| (v.as_str(), l.as_str(), d.as_deref()))
                        .collect();
                    let existing = q.answers.iter().find(|a| a.question_id == prompt.id);
                    let default_ids: Vec<&str> = if let Some(ans) = existing {
                        ans.selected_option_ids.iter().map(String::as_str).collect()
                    } else {
                        let recs: Vec<&str> = prompt.options.iter().filter(|o| o.recommended).map(|o| o.id.as_str()).collect();
                        if !recs.is_empty() {
                            if prompt.multi_select { recs } else { vec![recs[0]] }
                        } else {
                            vec![prompt.options[0].id.as_str()]
                        }
                    };
                    f = f.check_list(
                        &trunc(&prompt.prompt, 1_800),
                        &format!("q_{}", prompt.id),
                        &opts_ref,
                        prompt.multi_select,
                        &default_ids,
                    );
                    if prompt.allow_other {
                        let init_other = existing.and_then(|a| a.other_text.as_deref()).unwrap_or("");
                        f = f.text_field(
                            "Other preference or constraint (optional)",
                            &format!("other_{}", prompt.id),
                            Some("Optional custom answer…"),
                            false,
                            init_other,
                        );
                    }
                }
                f.text_field("Note", "note", Some("Optional note for the agent…"), false, "")
                    .buttons(&[("submit", "Submit answer", true)])
                    .build()
            }
            Self::PackReview { roles, .. } => {
                let mut f = Form::new();
                if ctx.role_options.is_empty() {
                    f = f.data("roles", json!(roles));
                } else {
                    let opts: Vec<(&str, &str, Option<&str>)> = ctx
                        .role_options
                        .iter()
                        .map(|(id, title)| (id.as_str(), title.as_str(), None))
                        .collect();
                    let picked: Vec<&str> = roles.iter().map(String::as_str).collect();
                    f = f.check_list("Roles that get its skills", "roles", &opts, true, &picked);
                }
                f.text_field("Note", "note", Some("Note for the agent (optional)…"), false, "")
                    .buttons(&[("approve", "Approve", true), ("reject", "Send back", false)])
                    .build()
            }
            Self::SkillScan { pack, findings } => {
                let mut f = Form::new().key_values(&[("Skill", &trunc(pack, 500))]);
                if !findings.is_empty() {
                    let lines: Vec<String> = findings.iter().take(20).map(|l| format!("- `{}`", trunc(l, 250))).collect();
                    f = f.markdown(&format!("### Scan findings\n{}", lines.join("\n")));
                }
                f.text_field("Note", "note", Some("Note for the agent (optional)…"), false, "")
                    .buttons(&[("approve", "Approve", true), ("reject", "Send back", false)])
                    .build()
            }
            Self::MemoryReview { memories } => {
                let mut f = Form::new();
                if let Some(items) = memories.as_array().filter(|a| !a.is_empty()) {
                    let lines: Vec<String> = items
                        .iter()
                        .take(15)
                        .map(|m| {
                            let kind = m.get("kind").or_else(|| m.get("memoryType")).and_then(Value::as_str).unwrap_or("Memory");
                            let text = m.get("text").or_else(|| m.get("summary")).or_else(|| m.get("content")).and_then(Value::as_str).unwrap_or("");
                            format!("- **{kind}:** {}", trunc(text, 250))
                        })
                        .collect();
                    f = f.markdown(&lines.join("\n"));
                }
                f.text_field("Note", "note", Some("Note for the agent (optional)…"), false, "")
                    .buttons(&[("approve", "Approve", true), ("reject", "Send back", false)])
                    .build()
            }
            Self::Info { markdown } => {
                let mut f = Form::new();
                if !markdown.trim().is_empty() {
                    f = f.markdown(&trunc(markdown, 7_500));
                }
                f.text_field("Note", "note", Some("Note for the agent (optional)…"), false, "")
                    .buttons(&[("approve", "Approve", true), ("reject", "Send back", false)])
                    .build()
            }
        }
    }
}

/// Unified decision record rendered in Inbox and inline inside Chat threads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct VisualDecision {
    pub id: String,
    pub project_id: String,
    pub from_id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub details: String,
    pub waiting: bool,
    pub owner_only: bool,
    pub status: DecisionStatus,
    pub payload: DecisionPayload,
    #[serde(default)]
    pub form: Option<FormSpec>,
    #[serde(default)]
    pub answer: Option<FormAnswer>,
    pub note: Option<String>,
    pub created_at: String,
    pub closed_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::form::{validate, FormPayload};

    #[test]
    fn build_form_produces_valid_specs_for_all_kinds() {
        let ctx = DecisionFormContext {
            role_options: vec![("coder".into(), "Developer".into()), ("reviewer".into(), "Reviewer".into())],
            team_names: HashMap::from([("coder".into(), "Ada".into()), ("lead".into(), "Lead".into())]),
        };
        let samples = vec![
            DecisionPayload::Permission(PermissionPayload {
                tool_name: "bash".into(),
                command_or_path: "cargo test".into(),
                reason: "Verify suite".into(),
                scope_hint: Some("workspace".into()),
                resolution: None,
            }),
            DecisionPayload::SecondOpinion(SecondOpinionPayload {
                task_id: Some("T1".into()),
                gate_id: Some("second-opinion".into()),
                recommendation: Some("Option A".into()),
                confidence: Some("High".into()),
                option_a: OpinionSide {
                    label: "Sliding window".into(),
                    author_id: "coder".into(),
                    summary: "Fast edge check".into(),
                    rationale_markdown: "### Why\nLow latency.".into(),
                    risks: vec!["NAT sharing".into()],
                },
                option_b: OpinionSide {
                    label: "Token bucket".into(),
                    author_id: "lead".into(),
                    summary: "DB backed".into(),
                    rationale_markdown: "Exact state.".into(),
                    risks: vec![],
                },
                can_waive_gate: true,
                chosen_side: None,
            }),
            DecisionPayload::MeetingRequest {
                meeting_id: "m1".into(),
                meeting_kind: MeetingKind::Standup,
                urgency: MeetingUrgency::High,
                participant_ids: vec!["coder".into(), "lead".into()],
                agenda_preview: vec!["Check blockers".into()],
            },
            DecisionPayload::Question(QuestionPayload {
                questions: vec![QuestionPrompt {
                    id: "q1".into(),
                    prompt: "Pick runner".into(),
                    multi_select: false,
                    allow_other: true,
                    options: vec![QuestionOption { id: "a".into(), label: "A".into(), description: None, recommended: true }],
                }],
                answers: vec![],
            }),
            DecisionPayload::PackReview {
                pack: "acme/pack".into(),
                from: None,
                to: "abc123".into(),
                from_tree: None,
                to_tree: "def456".into(),
                changed: vec![],
                other_files: vec![],
                agents: vec![],
                egress: vec![],
                secrets: vec![],
                ignored: vec![],
                findings: vec![],
                roles: vec!["coder".into()],
            },
            DecisionPayload::SkillScan { pack: "acme/s".into(), findings: vec!["warn x:1 y".into()] },
            DecisionPayload::MemoryReview { memories: json!([{ "kind": "Lesson", "text": "Keep helpers small" }]) },
            DecisionPayload::Info { markdown: "Heads up".into() },
            DecisionPayload::Form(FormPayload {
                form: Form::new().text("Hi", None).buttons(&[("ok", "OK", true)]).build(),
                answer: None,
            }),
        ];
        for payload in samples {
            let spec = payload.build_form(&ctx);
            let val = json!({ "components": spec.components, "data": spec.data });
            validate(&val).expect("generated decision form must validate");
        }
    }
}
