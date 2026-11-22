// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_core::{OutboxMessage, OutboxMessageKind};
use chrono::Utc;
use rusqlite::OptionalExtension;

use crate::{Db, DbError, Result};

/// Persisted delivery queue keyed by `(project_id, agent_id, epoch, seq)`.
///
/// Keying delivery cursors by server `epoch` guarantees that an HQ restart never drops
/// newly queued items when a surviving `arima-shim` polls with an `ack` from a prior epoch.
#[derive(Debug, Clone)]
pub struct OutboxRepo {
    db: Db,
}

impl OutboxRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Enqueues a durable message for `(project_id, agent_id)` under `epoch`.
    pub fn enqueue(
        &self,
        project_id: &str,
        agent_id: &str,
        epoch: i64,
        kind: OutboxMessageKind,
        payload_json: &str,
    ) -> Result<OutboxMessage> {
        let now = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            let next_seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1
                 FROM agent_outbox
                 WHERE project_id = ?1 AND agent_id = ?2 AND epoch = ?3",
                rusqlite::params![project_id, agent_id, epoch],
                |row| row.get(0),
            )?;

            conn.execute(
                "INSERT INTO agent_outbox
                    (project_id, agent_id, epoch, seq, kind, payload_json, created_at, acked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                rusqlite::params![
                    project_id,
                    agent_id,
                    epoch,
                    next_seq,
                    kind.as_str(),
                    payload_json,
                    now
                ],
            )?;

            Ok::<_, DbError>(OutboxMessage {
                project_id: project_id.to_owned(),
                agent_id: agent_id.to_owned(),
                epoch,
                seq: next_seq,
                kind,
                payload_json: payload_json.to_owned(),
                created_at: now,
                acked_at: None,
            })
        })
    }

    /// Acknowledges items matching `(client_epoch, seq <= client_ack)` and returns the
    /// earliest remaining unacknowledged message across all epochs.
    ///
    /// A client polling with a stale `client_epoch != current_epoch` only acknowledges
    /// its matching `client_epoch` and never suppresses messages from `current_epoch`.
    pub fn next_pending(
        &self,
        project_id: &str,
        agent_id: &str,
        current_epoch: i64,
        client_epoch: i64,
        client_ack: i64,
    ) -> Result<Option<OutboxMessage>> {
        let now = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            if client_epoch > 0 && client_epoch <= current_epoch && client_ack > 0 {
                conn.execute(
                    "UPDATE agent_outbox
                     SET acked_at = ?1
                     WHERE project_id = ?2
                       AND agent_id = ?3
                       AND epoch = ?4
                       AND seq <= ?5
                       AND acked_at IS NULL",
                    rusqlite::params![now, project_id, agent_id, client_epoch, client_ack],
                )?;
            }

            let row = conn
                .query_row(
                    "SELECT project_id, agent_id, epoch, seq, kind, payload_json, created_at, acked_at
                     FROM agent_outbox
                     WHERE project_id = ?1
                       AND agent_id = ?2
                       AND acked_at IS NULL
                     ORDER BY epoch ASC, seq ASC
                     LIMIT 1",
                    rusqlite::params![project_id, agent_id],
                    |r| {
                        let kind_raw: String = r.get(4)?;
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                            kind_raw,
                            r.get::<_, String>(5)?,
                            r.get::<_, i64>(6)?,
                            r.get::<_, Option<i64>>(7)?,
                        ))
                    },
                )
                .optional()?;

            match row {
                None => Ok::<_, DbError>(None),
                Some((project_id, agent_id, epoch, seq, kind_raw, payload_json, created_at, acked_at)) => {
                    let kind = OutboxMessageKind::parse(&kind_raw).ok_or_else(|| {
                        DbError::InvalidInput(format!("unknown outbox message kind: {kind_raw}"))
                    })?;
                    Ok::<_, DbError>(Some(OutboxMessage {
                        project_id,
                        agent_id,
                        epoch,
                        seq,
                        kind,
                        payload_json,
                        created_at,
                        acked_at,
                    }))
                }
            }
        })
    }

    /// Counts unacknowledged messages waiting for `(project_id, agent_id)`.
    pub fn pending_count(&self, project_id: &str, agent_id: &str) -> Result<i64> {
        self.db.read(|conn| {
            let count = conn.query_row(
                "SELECT COUNT(*)
                 FROM agent_outbox
                 WHERE project_id = ?1 AND agent_id = ?2 AND acked_at IS NULL",
                rusqlite::params![project_id, agent_id],
                |row| row.get(0),
            )?;
            Ok::<_, DbError>(count)
        })
    }
}
