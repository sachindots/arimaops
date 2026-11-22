// SPDX-License-Identifier: AGPL-3.0-or-later

//! Security engagement scope, CVSS 4.0 vector parsing & scoring, and findings persistence.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Db, DbError, Result};

/// Project engagement scope persisted in `projects.config_json["scope"]`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScope {
    #[serde(default)]
    pub in_scope: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

/// Parsed CVSS 4.0 score & derived severity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cvss4Result {
    pub vector: String,
    pub score: f64,
    pub severity: String,
}

/// Persisted security finding matching the shared HTTP contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityFinding {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub target: String,
    pub cwe: Option<String>,
    pub cvss_vector: Option<String>,
    pub cvss_score: f64,
    pub severity: String,
    pub status: String,
    pub description_markdown: String,
    pub reproduction_markdown: String,
    pub remediation_markdown: String,
    pub evidence_refs: Vec<String>,
    pub reporter_id: Option<String>,
    pub verified: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Input payload for creating a security finding.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFindingInput {
    pub id: Option<String>,
    pub title: String,
    pub target: String,
    pub cwe: Option<String>,
    pub cvss_vector: Option<String>,
    pub cvss_score: Option<f64>,
    pub severity: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub description_markdown: String,
    #[serde(default)]
    pub reproduction_markdown: String,
    #[serde(default)]
    pub remediation_markdown: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub reporter_id: Option<String>,
    #[serde(default)]
    pub verified: bool,
}

/// Partial update payload for patching an existing security finding.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFindingInput {
    pub title: Option<String>,
    pub target: Option<String>,
    pub cwe: Option<Option<String>>,
    pub cvss_vector: Option<Option<String>>,
    pub cvss_score: Option<f64>,
    pub severity: Option<String>,
    pub status: Option<String>,
    pub description_markdown: Option<String>,
    pub reproduction_markdown: Option<String>,
    pub remediation_markdown: Option<String>,
    pub evidence_refs: Option<Vec<String>>,
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindingExtraData {
    #[serde(default)]
    cwe: Option<String>,
    #[serde(default)]
    cvss_vector: Option<String>,
    #[serde(default)]
    description_markdown: String,
    #[serde(default)]
    reproduction_markdown: String,
    #[serde(default)]
    remediation_markdown: String,
    #[serde(default)]
    evidence_refs: Vec<String>,
    #[serde(default)]
    reporter_id: Option<String>,
}

/// Maps a numeric CVSS score (`0.0–10.0`) to qualitative ArimaOps severity.
#[must_use]
pub fn severity_from_cvss_score(score: f64) -> &'static str {
    if score >= 9.0 {
        "critical"
    } else if score >= 7.0 {
        "high"
    } else if score >= 4.0 {
        "medium"
    } else if score > 0.0 {
        "low"
    } else {
        "info"
    }
}

/// Parses and validates a CVSS 4.0 vector string, calculating a `0.0–10.0` score and severity.
///
/// Validates all 11 required base metrics (`AV`, `AC`, `AT`, `PR`, `UI`, `VC`, `VI`, `VA`,
/// `SC`, `SI`, `SA`) and supports optional Threat (`E`), Environmental (`CR`, `IR`, `AR`, `M*`),
/// and Supplemental (`S`, `AU`, `R`, `V`, `RE`, `U`) metrics.
pub fn parse_and_score_cvss4(vector: &str) -> Result<Cvss4Result> {
    let trimmed = vector.trim();
    let Some(rest) = trimmed.strip_prefix("CVSS:4.0/") else {
        return Err(DbError::InvalidInput(
            "CVSS 4.0 vector must begin with 'CVSS:4.0/'".into(),
        ));
    };

    let mut metrics: HashMap<&str, &str> = HashMap::new();
    for part in rest.split('/') {
        let Some((k, v)) = part.split_once(':') else {
            return Err(DbError::InvalidInput(format!(
                "invalid CVSS 4.0 metric token '{part}'"
            )));
        };
        if metrics.insert(k, v).is_some() {
            return Err(DbError::InvalidInput(format!(
                "duplicate CVSS 4.0 metric '{k}'"
            )));
        }
    }

    let get_req = |key: &str| -> Result<&str> {
        metrics
            .get(key)
            .copied()
            .ok_or_else(|| DbError::InvalidInput(format!("missing required CVSS 4.0 metric '{key}'")))
    };

    let av = get_req("AV")?;
    let ac = get_req("AC")?;
    let at = get_req("AT")?;
    let pr = get_req("PR")?;
    let ui = get_req("UI")?;
    let vc = get_req("VC")?;
    let vi = get_req("VI")?;
    let va = get_req("VA")?;
    let sc = get_req("SC")?;
    let si = get_req("SI")?;
    let sa = get_req("SA")?;

    let av_pen = match av {
        "N" => 0.0,
        "A" => 0.65,
        "L" => 1.20,
        "P" => 2.00,
        _ => return Err(DbError::InvalidInput(format!("invalid AV value '{av}'"))),
    };
    let ac_pen = match ac {
        "L" => 0.0,
        "H" => 0.90,
        _ => return Err(DbError::InvalidInput(format!("invalid AC value '{ac}'"))),
    };
    let at_pen = match at {
        "N" => 0.0,
        "P" => 0.80,
        _ => return Err(DbError::InvalidInput(format!("invalid AT value '{at}'"))),
    };
    let pr_pen = match pr {
        "N" => 0.0,
        "L" => 1.15,
        "H" => 1.75,
        _ => return Err(DbError::InvalidInput(format!("invalid PR value '{pr}'"))),
    };
    let ui_pen = match ui {
        "N" => 0.0,
        "P" => 0.55,
        "A" => 0.95,
        _ => return Err(DbError::InvalidInput(format!("invalid UI value '{ui}'"))),
    };

    let imp_val = |key: &str, v: &str| -> Result<f64> {
        match v {
            "H" => Ok(1.0),
            "L" => Ok(0.65),
            "N" => Ok(0.0),
            _ => Err(DbError::InvalidInput(format!("invalid {key} value '{v}'"))),
        }
    };

    let vc_v = imp_val("VC", vc)?;
    let vi_v = imp_val("VI", vi)?;
    let va_v = imp_val("VA", va)?;
    let sc_v = imp_val("SC", sc)?;
    let si_v = imp_val("SI", si)?;
    let sa_v = imp_val("SA", sa)?;

    // Optional Exploit Maturity (E).
    let threat_mult = match metrics.get("E").copied() {
        None | Some("X") | Some("A") => 1.0,
        Some("P") => 0.92,
        Some("U") => 0.82,
        Some(other) => {
            return Err(DbError::InvalidInput(format!(
                "invalid E value '{other}'"
            )))
        }
    };

    let v_max = vc_v.max(vi_v).max(va_v);
    let v_sum = vc_v + vi_v + va_v;
    let s_max = sc_v.max(si_v).max(sa_v);
    let s_sum = sc_v + si_v + sa_v;

    if v_max == 0.0 && s_max == 0.0 {
        return Ok(Cvss4Result {
            vector: trimmed.to_owned(),
            score: 0.0,
            severity: "info".into(),
        });
    }

    let v_base = if v_max > 0.0 {
        v_max * 0.935 + (v_sum - v_max) * 0.0325
    } else {
        0.0
    };
    let s_base = if s_max > 0.0 {
        s_max * 0.935 + (s_sum - s_max) * 0.0325
    } else {
        0.0
    };

    let base_impact = if v_base > 0.0 && s_base > 0.0 {
        (9.3 * v_base.max(s_base) + 0.7 * v_base.min(s_base) + 0.35 * s_max).min(10.0)
    } else if v_base > 0.0 {
        9.3 * v_base
    } else {
        9.0 * s_base
    };

    let penalty = av_pen + ac_pen + at_pen + pr_pen + ui_pen;
    let raw = ((base_impact - penalty) * threat_mult).clamp(0.1, 10.0);
    let score = (raw * 10.0).round() / 10.0;

    Ok(Cvss4Result {
        vector: trimmed.to_owned(),
        score,
        severity: severity_from_cvss_score(score).to_owned(),
    })
}

fn normalize_status(raw: Option<&str>) -> Result<String> {
    let s = raw.unwrap_or("open").trim().to_ascii_lowercase();
    match s.as_str() {
        "open" | "confirmed" | "fixed" | "accepted" | "false-positive" => Ok(s),
        _ => Err(DbError::InvalidInput(format!(
            "invalid finding status '{s}': expected open|confirmed|fixed|accepted|false-positive"
        ))),
    }
}

fn normalize_severity(raw: &str) -> Result<String> {
    let s = raw.trim().to_ascii_lowercase();
    match s.as_str() {
        "critical" | "high" | "medium" | "low" | "info" => Ok(s),
        _ => Err(DbError::InvalidInput(format!(
            "invalid finding severity '{s}': expected critical|high|medium|low|info"
        ))),
    }
}

fn format_ts_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

/// SQLite repository for project engagement scope and security findings (`findings`).
#[derive(Debug, Clone)]
pub struct FindingsRepo {
    db: Db,
}

impl FindingsRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Reads `ProjectScope` from `projects.config_json["scope"]`.
    pub fn get_scope(&self, project_id: &str) -> Result<ProjectScope> {
        self.db.read(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(cfg_str) = raw else {
                return Err(DbError::InvalidInput(format!(
                    "project '{project_id}' not found"
                )));
            };
            let cfg: Value = serde_json::from_str(&cfg_str).unwrap_or_else(|_| json!({}));
            let scope = cfg
                .get("scope")
                .cloned()
                .and_then(|v| serde_json::from_value::<ProjectScope>(v).ok())
                .unwrap_or_default();
            Ok::<_, DbError>(scope)
        })
    }

    /// Persists `ProjectScope` into `projects.config_json["scope"]` without disturbing sibling keys.
    pub fn set_scope(&self, project_id: &str, scope: &ProjectScope) -> Result<ProjectScope> {
        let now_ms = Utc::now().timestamp_millis();
        let cleaned = ProjectScope {
            in_scope: scope
                .in_scope
                .iter()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect(),
            out_of_scope: scope
                .out_of_scope
                .iter()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect(),
            notes: scope.notes.trim().to_owned(),
        };

        self.db.transaction(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(cfg_str) = raw else {
                return Err(DbError::InvalidInput(format!(
                    "project '{project_id}' not found"
                )));
            };
            let mut cfg: Value = serde_json::from_str(&cfg_str).unwrap_or_else(|_| json!({}));
            if !cfg.is_object() {
                cfg = json!({});
            }
            if let Some(obj) = cfg.as_object_mut() {
                obj.insert(
                    "scope".into(),
                    serde_json::to_value(&cleaned)
                        .map_err(|e| DbError::InvalidInput(format!("scope json: {e}")))?,
                );
            }
            let updated_json = serde_json::to_string(&cfg)
                .map_err(|e| DbError::InvalidInput(format!("config json: {e}")))?;
            conn.execute(
                "UPDATE projects SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![updated_json, now_ms, project_id],
            )?;
            Ok::<_, DbError>(cleaned.clone())
        })
    }

    /// Lists all security findings for `project_id`, ordered by severity/score desc then newest first.
    pub fn list_findings(&self, project_id: &str) -> Result<Vec<SecurityFinding>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, title, severity, cvss_score, asset, status, verified,
                        data_json, created_at, updated_at
                 FROM findings
                 WHERE project_id = ?1
                 ORDER BY COALESCE(cvss_score, 0.0) DESC, created_at DESC, id ASC",
            )?;
            let rows = stmt.query_map([project_id], Self::map_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Loads a single security finding by `(project_id, finding_id)`.
    pub fn get_finding(
        &self,
        project_id: &str,
        finding_id: &str,
    ) -> Result<Option<SecurityFinding>> {
        self.db.read(|conn| {
            conn.query_row(
                "SELECT id, project_id, title, severity, cvss_score, asset, status, verified,
                        data_json, created_at, updated_at
                 FROM findings
                 WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, finding_id],
                Self::map_row,
            )
            .optional()
            .map_err(DbError::from)
        })
    }

    /// Creates a new security finding with CVSS 4.0 validation & scoring.
    pub fn create_finding(
        &self,
        project_id: &str,
        input: CreateFindingInput,
    ) -> Result<SecurityFinding> {
        let title = input.title.trim().to_owned();
        if title.is_empty() {
            return Err(DbError::InvalidInput("finding title is required".into()));
        }
        let target = input.target.trim().to_owned();
        if target.is_empty() {
            return Err(DbError::InvalidInput("finding target is required".into()));
        }

        let (cvss_vector, cvss_score, severity) = resolve_cvss_and_severity(
            input.cvss_vector.as_deref(),
            input.cvss_score,
            input.severity.as_deref(),
        )?;
        let status = normalize_status(input.status.as_deref())?;
        let now_ms = Utc::now().timestamp_millis();

        self.db.transaction(|conn| {
            let id = match input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(explicit) => explicit.to_owned(),
                None => {
                    let count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM findings WHERE project_id = ?1",
                        [project_id],
                        |r| r.get(0),
                    )?;
                    format!("F-{:03}", count + 1)
                }
            };

            let extra = FindingExtraData {
                cwe: input.cwe.and_then(|s| {
                    let t = s.trim().to_owned();
                    if t.is_empty() { None } else { Some(t) }
                }),
                cvss_vector: cvss_vector.clone(),
                description_markdown: input.description_markdown,
                reproduction_markdown: input.reproduction_markdown,
                remediation_markdown: input.remediation_markdown,
                evidence_refs: input.evidence_refs,
                reporter_id: input.reporter_id,
            };
            let data_json = serde_json::to_string(&extra)
                .map_err(|e| DbError::InvalidInput(format!("finding data json: {e}")))?;

            conn.execute(
                "INSERT INTO findings
                    (id, project_id, title, severity, cvss_score, asset, status, verified,
                     data_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                rusqlite::params![
                    id,
                    project_id,
                    title,
                    severity,
                    cvss_score,
                    target,
                    status,
                    i64::from(input.verified),
                    data_json,
                    now_ms,
                ],
            )?;

            Ok::<_, DbError>(SecurityFinding {
                id,
                project_id: project_id.to_owned(),
                title,
                target,
                cwe: extra.cwe,
                cvss_vector,
                cvss_score,
                severity,
                status,
                description_markdown: extra.description_markdown,
                reproduction_markdown: extra.reproduction_markdown,
                remediation_markdown: extra.remediation_markdown,
                evidence_refs: extra.evidence_refs,
                reporter_id: extra.reporter_id,
                verified: input.verified,
                created_at: format_ts_ms(now_ms),
                updated_at: format_ts_ms(now_ms),
            })
        })
    }

    /// Patches an existing security finding, recalculating CVSS 4.0 score & severity when updated.
    pub fn update_finding(
        &self,
        project_id: &str,
        finding_id: &str,
        patch: UpdateFindingInput,
    ) -> Result<SecurityFinding> {
        let now_ms = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            let mut current = conn
                .query_row(
                    "SELECT id, project_id, title, severity, cvss_score, asset, status, verified,
                            data_json, created_at, updated_at
                     FROM findings
                     WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![project_id, finding_id],
                    Self::map_row,
                )
                .optional()?
                .ok_or_else(|| {
                    DbError::InvalidInput(format!("finding '{finding_id}' not found"))
                })?;

            if let Some(title) = patch.title {
                let clean = title.trim().to_owned();
                if clean.is_empty() {
                    return Err(DbError::InvalidInput("finding title cannot be empty".into()));
                }
                current.title = clean;
            }
            if let Some(target) = patch.target {
                let clean = target.trim().to_owned();
                if clean.is_empty() {
                    return Err(DbError::InvalidInput("finding target cannot be empty".into()));
                }
                current.target = clean;
            }
            if let Some(cwe) = patch.cwe {
                current.cwe = cwe.and_then(|s| {
                    let t = s.trim().to_owned();
                    if t.is_empty() { None } else { Some(t) }
                });
            }
            if let Some(vec_opt) = patch.cvss_vector {
                let (v, s, sev) = resolve_cvss_and_severity(
                    vec_opt.as_deref(),
                    patch.cvss_score,
                    patch.severity.as_deref(),
                )?;
                current.cvss_vector = v;
                current.cvss_score = s;
                current.severity = sev;
            } else if let Some(score) = patch.cvss_score {
                let clamped = (score.clamp(0.0, 10.0) * 10.0).round() / 10.0;
                current.cvss_score = clamped;
                current.severity = match patch.severity.as_deref() {
                    Some(sev) => normalize_severity(sev)?,
                    None => severity_from_cvss_score(clamped).to_owned(),
                };
            } else if let Some(sev) = patch.severity {
                current.severity = normalize_severity(&sev)?;
            }

            if let Some(status) = patch.status {
                current.status = normalize_status(Some(&status))?;
            }
            if let Some(desc) = patch.description_markdown {
                current.description_markdown = desc;
            }
            if let Some(repro) = patch.reproduction_markdown {
                current.reproduction_markdown = repro;
            }
            if let Some(remed) = patch.remediation_markdown {
                current.remediation_markdown = remed;
            }
            if let Some(ev) = patch.evidence_refs {
                current.evidence_refs = ev;
            }
            if let Some(verified) = patch.verified {
                current.verified = verified;
            }

            let extra = FindingExtraData {
                cwe: current.cwe.clone(),
                cvss_vector: current.cvss_vector.clone(),
                description_markdown: current.description_markdown.clone(),
                reproduction_markdown: current.reproduction_markdown.clone(),
                remediation_markdown: current.remediation_markdown.clone(),
                evidence_refs: current.evidence_refs.clone(),
                reporter_id: current.reporter_id.clone(),
            };
            let data_json = serde_json::to_string(&extra)
                .map_err(|e| DbError::InvalidInput(format!("finding data json: {e}")))?;

            conn.execute(
                "UPDATE findings
                 SET title = ?1,
                     severity = ?2,
                     cvss_score = ?3,
                     asset = ?4,
                     status = ?5,
                     verified = ?6,
                     data_json = ?7,
                     updated_at = ?8
                 WHERE project_id = ?9 AND id = ?10",
                rusqlite::params![
                    current.title,
                    current.severity,
                    current.cvss_score,
                    current.target,
                    current.status,
                    i64::from(current.verified),
                    data_json,
                    now_ms,
                    project_id,
                    finding_id,
                ],
            )?;
            current.updated_at = format_ts_ms(now_ms);
            Ok::<_, DbError>(current)
        })
    }

    fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SecurityFinding> {
        let data_raw: String = r.get(8)?;
        let extra: FindingExtraData = serde_json::from_str(&data_raw).unwrap_or_default();
        let created_ms: i64 = r.get(9)?;
        let updated_ms: i64 = r.get(10)?;
        let score: f64 = r.get::<_, Option<f64>>(4)?.unwrap_or(0.0);
        Ok(SecurityFinding {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            severity: r.get(3)?,
            cvss_score: score,
            target: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            status: r.get(6)?,
            verified: r.get::<_, i64>(7)? != 0,
            cwe: extra.cwe,
            cvss_vector: extra.cvss_vector,
            description_markdown: extra.description_markdown,
            reproduction_markdown: extra.reproduction_markdown,
            remediation_markdown: extra.remediation_markdown,
            evidence_refs: extra.evidence_refs,
            reporter_id: extra.reporter_id,
            created_at: format_ts_ms(created_ms),
            updated_at: format_ts_ms(updated_ms),
        })
    }
}

fn resolve_cvss_and_severity(
    vector: Option<&str>,
    score_opt: Option<f64>,
    severity_opt: Option<&str>,
) -> Result<(Option<String>, f64, String)> {
    if let Some(vec_str) = vector.map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = parse_and_score_cvss4(vec_str)?;
        return Ok((Some(parsed.vector), parsed.score, parsed.severity));
    }
    if let Some(score) = score_opt {
        if !(0.0..=10.0).contains(&score) || score.is_nan() {
            return Err(DbError::InvalidInput(
                "cvssScore must be between 0.0 and 10.0".into(),
            ));
        }
        let rounded = (score * 10.0).round() / 10.0;
        let sev = match severity_opt {
            Some(s) => normalize_severity(s)?,
            None => severity_from_cvss_score(rounded).to_owned(),
        };
        return Ok((None, rounded, sev));
    }
    let sev = match severity_opt {
        Some(s) => normalize_severity(s)?,
        None => "medium".to_owned(),
    };
    let default_score = match sev.as_str() {
        "critical" => 9.5,
        "high" => 7.8,
        "medium" => 5.3,
        "low" => 2.6,
        _ => 0.0,
    };
    Ok((None, default_score, sev))
}
