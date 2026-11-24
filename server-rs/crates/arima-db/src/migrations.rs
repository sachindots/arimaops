// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::atomic::AtomicU64;

use chrono::Utc;
use rusqlite::Connection;

use crate::{run_savepoint, DbError, Result};

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "001_initial_v2_schema",
        sql: INITIAL_V2_SCHEMA,
    },
    Migration {
        version: 2,
        name: "002_meetings_schema",
        sql: MEETINGS_V2_SCHEMA,
    },
    Migration {
        version: 3,
        name: "003_auth_throttle_schema",
        sql: AUTH_THROTTLE_V2_SCHEMA,
    },
    Migration {
        version: 4,
        name: "004_m4_beta_schema",
        sql: M4_BETA_V2_SCHEMA,
    },
    Migration {
        version: 5,
        name: "005_m5_ga_schema",
        sql: M5_GA_V2_SCHEMA,
    },
    Migration {
        version: 6,
        name: "006_goal_text",
        sql: GOAL_TEXT_SCHEMA,
    },
    Migration {
        version: 7,
        name: "007_agent_secrets",
        sql: AGENT_SECRETS_SCHEMA,
    },
    Migration {
        version: 8,
        name: "008_mcp_tokens",
        sql: MCP_TOKENS_SCHEMA,
    },
    Migration {
        version: 9,
        name: "009_skill_pins",
        sql: SKILL_PINS_SCHEMA,
    },
    // 010 belongs to another track; `migrate` applies each missing version, so the order they land in doesn't matter.
    Migration {
        version: 11,
        name: "011_agent_egress",
        sql: AGENT_EGRESS_SCHEMA,
    },
    // 012 is left to the packs track.
    Migration {
        version: 13,
        name: "013_egress_access",
        sql: EGRESS_ACCESS_SCHEMA,
    },
    Migration {
        version: 14,
        name: "014_skill_approvals",
        sql: SKILL_APPROVALS_SCHEMA,
    },
    Migration {
        version: 15,
        name: "015_cleanup_retired_artifacts",
        sql: CLEANUP_RETIRED_ARTIFACTS_SCHEMA,
    },
];

/// Adds an index on `mcp_tokens.token_hash` for direct lookup, retires the six dead visual decision
/// kinds into plain `info` cards (dismissing open ones), and drops the retired tool connections registry.
const CLEANUP_RETIRED_ARTIFACTS_SCHEMA: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);

UPDATE visual_decisions
SET status = CASE status WHEN 'open' THEN 'dismissed' ELSE status END,
    waiting = 0,
    closed_at = COALESCE(closed_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    payload_json = json_object('kind', 'info', 'markdown', COALESCE(NULLIF(details, ''), title))
WHERE json_extract(payload_json, '$.kind') IN (
    'spec-approval', 'plan-approval', 'gate-approval',
    'send-proposal', 'spend-alert', 'overflow-fallback'
);

DROP TABLE IF EXISTS tool_connections;
DELETE FROM server_settings WHERE key LIKE 'connection-meta:%';
"#;

/// Each project's own answer on a pinned skill's current hash, like a pack's approval. `skill_pins` keeps the
/// fetched files (content-addressed, shared) and the scanner's verdict; `decision_id` here is the project's Inbox
/// card for `content_hash`, and only that card can approve it. Existing answers move to the project whose card
/// gave them.
const SKILL_APPROVALS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS skill_approvals (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    skill_ref     TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    decision_id   TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, skill_ref)
);

INSERT OR IGNORE INTO skill_approvals (project_id, skill_ref, content_hash, status, decision_id, updated_at)
    SELECT d.project_id, p.skill_ref, p.content_hash, CASE p.status WHEN 'blocked' THEN 'pending' ELSE p.status END, p.decision_id, p.updated_at
    FROM skill_pins p JOIN visual_decisions d ON d.id = p.decision_id;

UPDATE skill_pins SET status = 'pending' WHERE status IN ('approved', 'rejected');
UPDATE skill_pins SET decision_id = NULL;
"#;

/// One Inbox access request per agent, host and port that enforce mode refused, and how the owner answered it.
/// `once` is allowed until `expires_at`; `project` added a project rule; `denied` is never asked about again.
const EGRESS_ACCESS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS egress_access (
    id           INTEGER PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id     TEXT NOT NULL,
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'once', 'project', 'denied')),
    requested_at INTEGER NOT NULL,
    expires_at   INTEGER,
    UNIQUE (project_id, agent_id, host, port)
);
"#;

/// Each project's egress mode, its own allowed hosts, and the hosts its agents reached that enforce mode would
/// block (one row per agent, host and port). The retired HQ-wide `sandboxProxy` setting goes.
const AGENT_EGRESS_SCHEMA: &str = r#"
ALTER TABLE projects ADD COLUMN egress_mode TEXT NOT NULL DEFAULT 'observe' CHECK (egress_mode IN ('off', 'observe', 'enforce'));

CREATE TABLE IF NOT EXISTS egress_rules (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rule        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, rule)
);

CREATE TABLE IF NOT EXISTS egress_would_block (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    ignored     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, agent_id, host, port)
);

DELETE FROM server_settings WHERE key = 'sandboxProxy';
"#;

/// Agent Skills pinned HQ-wide: one row per skill ref, at one commit, with the hash of its files.
/// `decision_id` is the Inbox card for the current hash; only that card can approve it.
const SKILL_PINS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS skill_pins (
    skill_ref     TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    path          TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL,
    commit_sha    TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'blocked')),
    decision_id   TEXT,
    findings_json TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
"#;

/// One HQ tool-server bearer token per agent, stored as a SHA-256 hex digest so it survives an HQ restart.
const MCP_TOKENS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mcp_tokens (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, agent_id)
);
"#;

/// App variables and service keys, encrypted with the vault key. `agent_id` is '' for "every agent".
const AGENT_SECRETS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS agent_secrets (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('env', 'key')),
    name        TEXT NOT NULL,
    value_enc   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, agent_id, kind, name)
);
"#;

/// Goals carry free-text target and current values ("$5k"), not just numbers.
const GOAL_TEXT_SCHEMA: &str = r#"
ALTER TABLE goals ADD COLUMN target_text TEXT NOT NULL DEFAULT '';
ALTER TABLE goals ADD COLUMN current_text TEXT NOT NULL DEFAULT '';
"#;

const INITIAL_V2_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
    disabled        INTEGER NOT NULL DEFAULT 0,
    totp_secret_enc TEXT,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    root_path       TEXT NOT NULL,
    template_id     TEXT,
    config_json     TEXT NOT NULL DEFAULT '{}',
    paused          INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_project_roles (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS device_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    label           TEXT NOT NULL,
    origin          TEXT,
    remote          INTEGER NOT NULL DEFAULT 0,
    elevated_until  INTEGER,
    last_seen_at    INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions (user_id);

CREATE TABLE IF NOT EXISTS passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_json TEXT NOT NULL,
    label           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id   TEXT,
    actor_name      TEXT NOT NULL,
    actor_role      TEXT,
    project_id      TEXT,
    action          TEXT NOT NULL,
    target          TEXT,
    summary         TEXT NOT NULL,
    remote          INTEGER NOT NULL DEFAULT 0,
    allowed         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS boards (
    id              TEXT NOT NULL,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL,
    spec_version    INTEGER NOT NULL DEFAULT 0,
    spec_markdown   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS goals (
    id              TEXT NOT NULL,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    metric          TEXT NOT NULL,
    target_value    REAL NOT NULL,
    current_value   REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT NOT NULL,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id         TEXT NOT NULL,
    goal_id          TEXT,
    stage_id         TEXT NOT NULL,
    status           TEXT NOT NULL,
    title            TEXT NOT NULL,
    owner_id         TEXT,
    pr_number        INTEGER,
    template_id      TEXT,
    template_version INTEGER,
    data_json        TEXT NOT NULL DEFAULT '{}',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id, board_id) REFERENCES boards(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, goal_id) REFERENCES goals(project_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks (project_id, board_id, status);

CREATE TABLE IF NOT EXISTS task_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL,
    status          TEXT NOT NULL,
    stage_id        TEXT,
    owner_id        TEXT,
    at              INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_events_lookup ON task_events (project_id, task_id, at);

CREATE TABLE IF NOT EXISTS gate_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL,
    gate_id         TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('passed', 'failed', 'reset')),
    by_id           TEXT NOT NULL,
    note            TEXT,
    url             TEXT,
    at              INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gate_events_lookup ON gate_events (project_id, task_id, at);

CREATE TABLE IF NOT EXISTS scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL,
    scorer          TEXT NOT NULL,
    pass            INTEGER NOT NULL,
    reason          TEXT NOT NULL,
    cost_usd        REAL NOT NULL DEFAULT 0,
    at              INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS action_answers (
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    kind            TEXT NOT NULL,
    decision        TEXT NOT NULL,
    at              INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS visual_decisions (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_id         TEXT NOT NULL,
    task_id         TEXT,
    title           TEXT NOT NULL,
    details         TEXT NOT NULL,
    waiting         INTEGER NOT NULL DEFAULT 0,
    owner_only      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
    payload_json    TEXT NOT NULL,
    note            TEXT,
    created_at      INTEGER NOT NULL,
    closed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_visual_decisions_project ON visual_decisions (project_id, status, created_at);

CREATE TABLE IF NOT EXISTS visual_feedback (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_user_id      TEXT NOT NULL,
    target_id           TEXT,
    source_kind         TEXT NOT NULL,
    page_url            TEXT NOT NULL,
    viewport_width      INTEGER NOT NULL,
    viewport_height     INTEGER NOT NULL,
    note                TEXT NOT NULL,
    selection_json      TEXT,
    console_errors_json TEXT NOT NULL DEFAULT '[]',
    image_path          TEXT NOT NULL,
    workspace_rel_dir   TEXT NOT NULL,
    route_json          TEXT NOT NULL,
    created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visual_feedback_project ON visual_feedback (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    task_id         TEXT,
    tag             TEXT,
    body            TEXT NOT NULL,
    decision_id     TEXT REFERENCES visual_decisions(id) ON DELETE SET NULL,
    feedback_id     TEXT REFERENCES visual_feedback(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, created_at);

CREATE TABLE IF NOT EXISTS agent_outbox (
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    epoch           INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    acked_at        INTEGER,
    PRIMARY KEY (project_id, agent_id, epoch, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_outbox_pending ON agent_outbox (project_id, agent_id, acked_at, epoch, seq);

CREATE TABLE IF NOT EXISTS usage_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id          TEXT NOT NULL,
    task_id           TEXT,
    account_id        TEXT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events (project_id, at);

CREATE TABLE IF NOT EXISTS memories (
    id              TEXT NOT NULL,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mem_type        TEXT NOT NULL,
    text            TEXT NOT NULL,
    certified       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS memory_about (
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    memory_id       TEXT NOT NULL,
    about           TEXT NOT NULL,
    PRIMARY KEY (project_id, memory_id, about),
    FOREIGN KEY (project_id, memory_id) REFERENCES memories(project_id, id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    project_id UNINDEXED,
    text,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS findings (
    id              TEXT NOT NULL,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    severity        TEXT NOT NULL,
    cvss_score      REAL,
    asset           TEXT,
    status          TEXT NOT NULL,
    verified        INTEGER NOT NULL DEFAULT 0,
    data_json       TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);
"#;

const MEETINGS_V2_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meetings (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL CHECK (kind IN ('standup', 'discussion', 'kickoff', 'review')),
    status               TEXT NOT NULL CHECK (status IN ('requested', 'live', 'paused', 'minutes-review', 'closed', 'declined')),
    urgency              TEXT NOT NULL CHECK (urgency IN ('low', 'normal', 'high')),
    title                TEXT NOT NULL,
    moderator_id         TEXT NOT NULL,
    participant_ids_json TEXT NOT NULL DEFAULT '[]',
    requested_by         TEXT NOT NULL,
    voice_enabled        INTEGER NOT NULL DEFAULT 0,
    voice_provider       TEXT NOT NULL DEFAULT 'browser-web-speech',
    agenda_json          TEXT NOT NULL DEFAULT '[]',
    minutes_json         TEXT,
    created_at           INTEGER NOT NULL,
    started_at           INTEGER,
    closed_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings (project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_turns (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_id      TEXT NOT NULL,
    speaker_role    TEXT NOT NULL,
    kind            TEXT NOT NULL,
    body_markdown   TEXT NOT NULL,
    decision_id     TEXT REFERENCES visual_decisions(id) ON DELETE SET NULL,
    spoken_text     TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_turns_meeting ON meeting_turns (meeting_id, created_at ASC);
"#;

const AUTH_THROTTLE_V2_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS auth_throttle (
    bucket       TEXT PRIMARY KEY,
    failures     INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS totp_used_steps (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step    INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, step)
);

CREATE TABLE IF NOT EXISTS bootstrap_sessions (
    id             TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    label          TEXT NOT NULL,
    origin         TEXT,
    remote         INTEGER NOT NULL DEFAULT 0,
    elevated_until INTEGER,
    last_seen_at   INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);
"#;

const M4_BETA_V2_SCHEMA: &str = r#"
ALTER TABLE memories ADD COLUMN conflict_id TEXT;
ALTER TABLE memories ADD COLUMN promoted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN superseded_by TEXT;

CREATE TABLE IF NOT EXISTS promoted_lessons (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_memory_id TEXT,
    template_id      TEXT NOT NULL,
    mem_type         TEXT NOT NULL,
    text             TEXT NOT NULL,
    created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promoted_lessons_template
    ON promoted_lessons (template_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vault_secrets (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL,
    provider    TEXT NOT NULL,
    label       TEXT NOT NULL,
    secret_enc  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_provider
    ON vault_secrets (provider);
"#;

const M5_GA_V2_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS improvement_proposals (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    rationale   TEXT NOT NULL,
    category    TEXT NOT NULL,
    diff_hint   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed')),
    note        TEXT,
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_improvement_proposals_project
    ON improvement_proposals (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_runs (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    pass_rate      REAL NOT NULL,
    avg_score      REAL NOT NULL,
    avg_latency_ms REAL NOT NULL,
    cases_json     TEXT NOT NULL DEFAULT '[]',
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_project
    ON benchmark_runs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_connections (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    label       TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    secret_enc  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
"#;

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            applied_at  INTEGER NOT NULL
        );",
    )?;

    let applied: Vec<i64> = conn
        .prepare("SELECT version FROM schema_migrations")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    let sp_seq = AtomicU64::new(10_000);
    for m in MIGRATIONS {
        if applied.contains(&m.version) {
            continue;
        }
        run_savepoint(conn, &sp_seq, |c| {
            c.execute_batch(m.sql)?;
            c.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![m.version, m.name, Utc::now().timestamp_millis()],
            )?;
            Ok::<_, DbError>(())
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::SKILL_APPROVALS_SCHEMA;
    use crate::{Db, DbError};

    #[test]
    fn skill_answers_move_to_the_project_whose_card_gave_them() {
        let db = Db::open_in_memory().unwrap();
        db.transaction(|c| {
            c.execute_batch(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('p-a', 'a', 'A', '/a', 1, 1);
                 INSERT INTO visual_decisions (id, project_id, from_id, title, details, status, payload_json, created_at)
                     VALUES ('dec-1', 'p-a', 'hq', 't', 'd', 'resolved', '{}', 1);
                 INSERT INTO skill_pins (skill_ref, url, path, name, description, commit_sha, content_hash, status, decision_id, created_at, updated_at)
                     VALUES ('a/b@x', 'u', 'p', 'x', 'd', 'c', 'h1', 'approved', 'dec-1', 1, 1),
                            ('a/b@y', 'u', 'p', 'y', 'd', 'c', 'h2', 'blocked', NULL, 1, 1);",
            )?;
            c.execute_batch(SKILL_APPROVALS_SCHEMA)?;
            Ok::<_, DbError>(())
        })
        .unwrap();
        let rows: Vec<(String, String, String)> = db
            .read(|c| {
                let mut s = c.prepare("SELECT a.project_id, a.status, p.status FROM skill_approvals a JOIN skill_pins p USING (skill_ref)")?;
                let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, DbError>(rows)
            })
            .unwrap();
        assert_eq!(rows, [("p-a".to_owned(), "approved".to_owned(), "pending".to_owned())], "the answer moved; the stored pin keeps only the scan");
    }
}
