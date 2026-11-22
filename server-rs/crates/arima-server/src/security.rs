// SPDX-License-Identifier: AGPL-3.0-or-later

//! Security Engagement 6-format report exporter:
//! `html` (print-to-PDF with strict HTML escaping), `markdown`, `hackerone`,
//! `bugcrowd`, `json`, and `sarif` (SARIF 2.1.0).

use arima_db::{ProjectScope, SecurityFinding};
use chrono::Utc;
use serde_json::{json, Value};

/// Rendered report artifact ready to send as an HTTP response.
#[derive(Debug, Clone)]
pub struct ExportedReport {
    pub content_type: &'static str,
    pub content_disposition: String,
    pub body: String,
}

/// Strictly escapes HTML special characters so untrusted finding fields can never execute script.
#[must_use]
pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

fn safe_filename_slug(raw: &str) -> String {
    let slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "project".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn bugcrowd_priority(severity: &str) -> &'static str {
    match severity {
        "critical" => "P1",
        "high" => "P2",
        "medium" => "P3",
        "low" => "P4",
        _ => "P5",
    }
}

fn sarif_level(severity: &str) -> &'static str {
    match severity {
        "critical" | "high" => "error",
        "medium" => "warning",
        _ => "note",
    }
}

/// Renders all project findings into one of the 6 supported formats.
pub fn export_findings_report(
    format: &str,
    project_id: &str,
    project_name: &str,
    project_slug: &str,
    scope: &ProjectScope,
    findings: &[SecurityFinding],
) -> Result<ExportedReport, String> {
    let slug = safe_filename_slug(project_slug);
    let generated_at = Utc::now().to_rfc3339();

    match format.trim().to_ascii_lowercase().as_str() {
        "html" | "pdf" => Ok(ExportedReport {
            content_type: "text/html; charset=utf-8",
            content_disposition: format!("inline; filename=\"findings-{slug}.html\""),
            body: render_html(project_name, &generated_at, scope, findings),
        }),
        "markdown" | "md" => Ok(ExportedReport {
            content_type: "text/markdown; charset=utf-8",
            content_disposition: format!("attachment; filename=\"findings-{slug}.md\""),
            body: render_markdown(project_name, &generated_at, scope, findings),
        }),
        "hackerone" => Ok(ExportedReport {
            content_type: "text/markdown; charset=utf-8",
            content_disposition: format!("attachment; filename=\"findings-{slug}-hackerone.md\""),
            body: render_hackerone(project_name, &generated_at, findings),
        }),
        "bugcrowd" => Ok(ExportedReport {
            content_type: "text/markdown; charset=utf-8",
            content_disposition: format!("attachment; filename=\"findings-{slug}-bugcrowd.md\""),
            body: render_bugcrowd(project_name, &generated_at, findings),
        }),
        "json" => Ok(ExportedReport {
            content_type: "application/json; charset=utf-8",
            content_disposition: format!("attachment; filename=\"findings-{slug}.json\""),
            body: render_json(project_id, project_name, &generated_at, scope, findings),
        }),
        "sarif" => Ok(ExportedReport {
            content_type: "application/sarif+json; charset=utf-8",
            content_disposition: format!("attachment; filename=\"findings-{slug}.sarif.json\""),
            body: render_sarif(project_id, project_name, findings),
        }),
        other => Err(format!(
            "unsupported export format '{other}': expected html|markdown|hackerone|bugcrowd|json|sarif"
        )),
    }
}

fn render_html(
    project_name: &str,
    generated_at: &str,
    scope: &ProjectScope,
    findings: &[SecurityFinding],
) -> String {
    let mut rows = String::new();
    for f in findings {
        let ev_html = if f.evidence_refs.is_empty() {
            "<p class=\"muted\">None attached.</p>".to_owned()
        } else {
            let items: String = f
                .evidence_refs
                .iter()
                .map(|r| format!("<li><code>{}</code></li>", escape_html(r)))
                .collect();
            format!("<ul>{items}</ul>")
        };

        rows.push_str(&format!(
            "<article class=\"finding\">\
             <h2>{id} — {title}</h2>\
             <p class=\"meta\">\
               <span class=\"pill sev-{sev}\">{sev_upper}</span> \
               <span>CVSS 4.0: <strong>{score:.1}</strong></span> \
               {vec_span}\
               {cwe_span}\
               <span>Status: {status}</span>\
             </p>\
             <p><strong>Target:</strong> <code>{target}</code></p>\
             <h3>Description</h3><pre class=\"md\">{desc}</pre>\
             <h3>Reproduction</h3><pre class=\"md\">{repro}</pre>\
             <h3>Remediation</h3><pre class=\"md\">{remed}</pre>\
             <h3>Evidence</h3>{ev}\
             </article>",
            id = escape_html(&f.id),
            title = escape_html(&f.title),
            sev = escape_html(&f.severity),
            sev_upper = escape_html(&f.severity.to_ascii_uppercase()),
            score = f.cvss_score,
            vec_span = f
                .cvss_vector
                .as_deref()
                .map(|v| format!("<code>{}</code> ", escape_html(v)))
                .unwrap_or_default(),
            cwe_span = f
                .cwe
                .as_deref()
                .map(|c| format!("<span>{}</span> ", escape_html(c)))
                .unwrap_or_default(),
            status = escape_html(&f.status),
            target = escape_html(&f.target),
            desc = escape_html(&f.description_markdown),
            repro = escape_html(&f.reproduction_markdown),
            remed = escape_html(&f.remediation_markdown),
            ev = ev_html,
        ));
    }

    let in_scope_html: String = if scope.in_scope.is_empty() {
        "<li>None</li>".into()
    } else {
        scope
            .in_scope
            .iter()
            .map(|s| format!("<li><code>{}</code></li>", escape_html(s)))
            .collect()
    };
    let out_scope_html: String = if scope.out_of_scope.is_empty() {
        "<li>None</li>".into()
    } else {
        scope
            .out_of_scope
            .iter()
            .map(|s| format!("<li><code>{}</code></li>", escape_html(s)))
            .collect()
    };

    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <title>ArimaOps Security Report — {name}</title>\n\
         <style>\
         body{{font-family:Inter,system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1.5rem;color:#111827;line-height:1.5}}\
         header{{border-bottom:1px solid #e5e7eb;padding-bottom:1rem;margin-bottom:1.5rem}}\
         .meta{{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;font-size:13px;color:#4b5563}}\
         .pill{{padding:2px 8px;border-radius:999px;font-weight:600;color:#fff;background:#6b7280}}\
         .sev-critical{{background:#dc2626}}.sev-high{{background:#ea580c}}.sev-medium{{background:#d97706}}.sev-low{{background:#4f46e5}}\
         .finding{{border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;page-break-inside:avoid}}\
         pre.md{{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:.75rem;font-family:inherit}}\
         code{{font-family:ui-monospace,monospace;font-size:12px}}\
         .muted{{color:#6b7280}}\
         </style>\n</head>\n<body>\n\
         <header><h1>ArimaOps Security Report — {name}</h1>\
         <p class=\"muted\">Generated {ts} · {count} finding(s)</p></header>\n\
         <section><h2>Scope</h2>\
         <h3>In Scope</h3><ul>{in_scope}</ul>\
         <h3>Out of Scope</h3><ul>{out_scope}</ul>\
         <p>{notes}</p></section>\n\
         <main>{findings_html}</main>\n</body>\n</html>\n",
        name = escape_html(project_name),
        ts = escape_html(generated_at),
        count = findings.len(),
        in_scope = in_scope_html,
        out_scope = out_scope_html,
        notes = escape_html(&scope.notes),
        findings_html = if rows.is_empty() {
            "<p class=\"muted\">No findings recorded.</p>".to_owned()
        } else {
            rows
        },
    )
}

fn render_markdown(
    project_name: &str,
    generated_at: &str,
    scope: &ProjectScope,
    findings: &[SecurityFinding],
) -> String {
    let mut out = format!(
        "# ArimaOps Security Engagement Report — {project_name}\n\n\
         Generated: `{generated_at}`  \n\
         Total findings: **{}**\n\n\
         ## Scope\n\n\
         - **In scope:** {}\n\
         - **Out of scope:** {}\n",
        findings.len(),
        if scope.in_scope.is_empty() {
            "None".into()
        } else {
            scope.in_scope.join(", ")
        },
        if scope.out_of_scope.is_empty() {
            "None".into()
        } else {
            scope.out_of_scope.join(", ")
        },
    );
    if !scope.notes.is_empty() {
        out.push_str(&format!("\n{}\n", scope.notes));
    }
    out.push_str("\n## Findings\n\n");
    for f in findings {
        out.push_str(&format!(
            "### {} — {}\n\n\
             - **Severity:** {} (CVSS 4.0: **{:.1}**{})\n\
             - **Target:** `{}`\n\
             - **Status:** `{}`{}\n\n\
             #### Description\n\n{}\n\n\
             #### Steps to Reproduce\n\n{}\n\n\
             #### Remediation\n\n{}\n\n",
            f.id,
            f.title,
            f.severity.to_ascii_uppercase(),
            f.cvss_score,
            f.cvss_vector
                .as_deref()
                .map(|v| format!(", `{v}`"))
                .unwrap_or_default(),
            f.target,
            f.status,
            f.cwe
                .as_deref()
                .map(|c| format!(" · **CWE:** `{c}`"))
                .unwrap_or_default(),
            f.description_markdown,
            f.reproduction_markdown,
            f.remediation_markdown,
        ));
        if !f.evidence_refs.is_empty() {
            out.push_str("#### Evidence\n\n");
            for ev in &f.evidence_refs {
                out.push_str(&format!("- `{ev}`\n"));
            }
            out.push('\n');
        }
    }
    out
}

fn render_hackerone(
    project_name: &str,
    generated_at: &str,
    findings: &[SecurityFinding],
) -> String {
    let mut out = format!(
        "# HackerOne Submission Bundle — {project_name}\n\nGenerated: `{generated_at}`\n\n"
    );
    for f in findings {
        out.push_str(&format!(
            "---\n\n\
             ## Summary\n\n**[{id}] {title}**\n\n\
             - **Asset:** `{target}`\n\
             - **Weakness:** {cwe}\n\
             - **Severity:** {sev} (CVSS 4.0 `{score:.1}`{vec})\n\n\
             ### Description\n\n{desc}\n\n\
             ### Steps To Reproduce\n\n{repro}\n\n\
             ### Impact & Remediation\n\n{remed}\n\n\
             ### Supporting Material/References\n\n{ev}\n\n",
            id = f.id,
            title = f.title,
            target = f.target,
            cwe = f.cwe.as_deref().unwrap_or("Unclassified"),
            sev = f.severity,
            score = f.cvss_score,
            vec = f
                .cvss_vector
                .as_deref()
                .map(|v| format!(" / `{v}`"))
                .unwrap_or_default(),
            desc = f.description_markdown,
            repro = f.reproduction_markdown,
            remed = f.remediation_markdown,
            ev = if f.evidence_refs.is_empty() {
                "- None".to_owned()
            } else {
                f.evidence_refs
                    .iter()
                    .map(|e| format!("- `{e}`"))
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        ));
    }
    out
}

fn render_bugcrowd(
    project_name: &str,
    generated_at: &str,
    findings: &[SecurityFinding],
) -> String {
    let mut out = format!(
        "# Bugcrowd Report Export — {project_name}\n\nGenerated: `{generated_at}`\n\n"
    );
    for f in findings {
        out.push_str(&format!(
            "---\n\n\
             ## {prio} — {title} ({id})\n\n\
             - **Priority:** {prio} ({sev})\n\
             - **CVSS 4.0:** {score:.1}{vec}\n\
             - **Target / URL:** `{target}`\n\
             - **CWE / VRT Reference:** {cwe}\n\n\
             ### Vulnerability Details\n\n{desc}\n\n\
             ### Proof of Concept\n\n{repro}\n\n\
             ### Remediation Guidance\n\n{remed}\n\n",
            prio = bugcrowd_priority(&f.severity),
            title = f.title,
            id = f.id,
            sev = f.severity,
            score = f.cvss_score,
            vec = f
                .cvss_vector
                .as_deref()
                .map(|v| format!(" (`{v}`)"))
                .unwrap_or_default(),
            target = f.target,
            cwe = f.cwe.as_deref().unwrap_or("N/A"),
            desc = f.description_markdown,
            repro = f.reproduction_markdown,
            remed = f.remediation_markdown,
        ));
    }
    out
}

fn render_json(
    project_id: &str,
    project_name: &str,
    generated_at: &str,
    scope: &ProjectScope,
    findings: &[SecurityFinding],
) -> String {
    let mut by_sev = serde_json::Map::new();
    for sev in ["critical", "high", "medium", "low", "info"] {
        let count = findings.iter().filter(|f| f.severity == sev).count();
        by_sev.insert(sev.to_owned(), json!(count));
    }
    let doc = json!({
        "engine": "ArimaOps",
        "projectId": project_id,
        "projectName": project_name,
        "generatedAt": generated_at,
        "scope": scope,
        "summary": {
            "total": findings.len(),
            "bySeverity": Value::Object(by_sev),
        },
        "findings": findings,
    });
    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into())
}

fn render_sarif(project_id: &str, project_name: &str, findings: &[SecurityFinding]) -> String {
    let mut rules = Vec::with_capacity(findings.len());
    let mut results = Vec::with_capacity(findings.len());

    for f in findings {
        let rule_id = f
            .cwe
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&f.id);

        rules.push(json!({
            "id": rule_id,
            "name": f.title,
            "shortDescription": { "text": f.title },
            "fullDescription": { "text": f.description_markdown },
            "help": {
                "text": f.remediation_markdown,
                "markdown": f.remediation_markdown,
            },
            "properties": {
                "tags": ["security", f.severity],
                "security-severity": format!("{:.1}", f.cvss_score),
                "cvssVector": f.cvss_vector,
                "cwe": f.cwe,
            }
        }));

        results.push(json!({
            "ruleId": rule_id,
            "level": sarif_level(&f.severity),
            "message": {
                "text": format!("{} ({}): {}", f.title, f.target, f.description_markdown)
            },
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": {
                        "uri": f.target
                    }
                }
            }],
            "partialFingerprints": {
                "arimaFindingId": f.id,
                "projectId": project_id,
            },
            "properties": {
                "findingId": f.id,
                "status": f.status,
                "severity": f.severity,
                "cvssScore": f.cvss_score,
                "cvssVector": f.cvss_vector,
                "cwe": f.cwe,
                "verified": f.verified,
                "evidenceRefs": f.evidence_refs,
            }
        }));
    }

    let doc = json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "ArimaOps",
                    "informationUri": "https://arimaops.tech",
                    "version": env!("CARGO_PKG_VERSION"),
                    "rules": rules,
                }
            },
            "automationDetails": {
                "id": format!("arimaops/{project_id}"),
                "description": { "text": format!("Security engagement findings for {project_name}") }
            },
            "results": results,
        }]
    });
    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into())
}
