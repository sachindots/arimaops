// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{Db, DbError, Result};

const SLICES: usize = 24;
const MS_PER_DAY: i64 = 86_400_000;

/// Single token/cost usage event recorded from a native HTTP+SSE runner or incremental JSONL tailer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventInput {
    pub project_id: String,
    pub agent_id: String,
    pub task_id: Option<String>,
    pub account_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
    pub at_ms: Option<i64>,
}

/// Aggregated per-agent usage matching `AgentUsage` in `src/store/usage.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageRow {
    pub agent_id: String,
    pub input: i64,
    pub cached: i64,
    pub output: i64,
    pub cost_usd: f64,
    /// Total tokens per slice of the window, oldest first (24 slices).
    pub series: Vec<i64>,
}

impl AgentUsageRow {
    #[must_use]
    pub fn total_tokens(&self) -> i64 {
        self.input + self.cached + self.output
    }
}

/// Windowed usage response returned by `GET /api/projects/{id}/usage?days=N`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageReport {
    pub days: u32,
    pub agents: Vec<AgentUsageRow>,
}

/// SQLite repository for `usage_events`.
#[derive(Debug, Clone)]
pub struct UsageRepo {
    db: Db,
}

impl UsageRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Inserts a usage event into `usage_events`.
    pub fn record_usage(&self, input: &UsageEventInput) -> Result<i64> {
        let at = input.at_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO usage_events
                    (project_id, agent_id, task_id, account_id, provider, model,
                     input_tokens, output_tokens, cache_read_tokens, cost_usd, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    input.project_id,
                    input.agent_id,
                    input.task_id,
                    input.account_id,
                    input.provider,
                    input.model,
                    input.input_tokens,
                    input.output_tokens,
                    input.cache_read_tokens,
                    input.cost_usd,
                    at,
                ],
            )?;
            Ok::<_, DbError>(conn.last_insert_rowid())
        })
    }

    /// Aggregates per-agent token & cost usage over the last `days` (`1..=90`), returning
    /// `{ days, agents: [{ agentId, input, cached, output, costUsd, series }] }` with 24
    /// chronological slices (oldest first).
    pub fn aggregate_project_usage(
        &self,
        project_id: &str,
        days: u32,
        now_ms: Option<i64>,
    ) -> Result<ProjectUsageReport> {
        let clamped_days = days.clamp(1, 90);
        let end_ms = now_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
        let window_ms = i64::from(clamped_days) * MS_PER_DAY;
        let start_ms = end_ms - window_ms;
        let slice_ms = (window_ms / i64::try_from(SLICES).unwrap_or(24)).max(1);

        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT agent_id, input_tokens, cache_read_tokens, output_tokens, cost_usd, at
                 FROM usage_events
                 WHERE project_id = ?1 AND at >= ?2 AND at <= ?3
                 ORDER BY at ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })?;

            let mut acc: HashMap<String, AgentUsageRow> = HashMap::new();
            for row in rows {
                let (agent_id, input, cached, output, cost_usd, at) = row?;
                let entry = acc.entry(agent_id.clone()).or_insert_with(|| AgentUsageRow {
                    agent_id,
                    input: 0,
                    cached: 0,
                    output: 0,
                    cost_usd: 0.0,
                    series: vec![0; SLICES],
                });
                entry.input += input;
                entry.cached += cached;
                entry.output += output;
                entry.cost_usd += cost_usd;

                let rel = (at - start_ms).max(0);
                let bucket = usize::try_from(rel / slice_ms)
                    .unwrap_or(SLICES - 1)
                    .min(SLICES - 1);
                entry.series[bucket] += input + cached + output;
            }

            let mut agents: Vec<AgentUsageRow> = acc.into_values().collect();
            agents.sort_by(|a, b| {
                b.total_tokens()
                    .cmp(&a.total_tokens())
                    .then_with(|| a.agent_id.cmp(&b.agent_id))
            });

            Ok::<_, DbError>(ProjectUsageReport {
                days: clamped_days,
                agents,
            })
        })
    }
}
