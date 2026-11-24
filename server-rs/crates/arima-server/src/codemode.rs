// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tools as code. With a project's switch on, each agent's CLI lists one tool server, the `codemode` runner inside
//! its own container. The runner asks HQ here for the agent's declarations: TypeScript for every tool the agent may
//! call, HQ's own (`codemode.arima.*`) and those of each tool server ticked on its seat (`codemode.<server>.*`), plus
//! the map from each identifier back to the real server and tool name. The runner calls the tools through HQ with
//! the agent's own token, so seat ticks, blocked servers, vault keys and audit apply as for a direct call.

use serde_json::{json, Map, Value};

use crate::integrations::{save_setting, setting, tool_servers};
use crate::mcp::{McpCaller, TOOLS};
use crate::state::AppState;

/// The description's cap, in characters (about 4,000 tokens). Past it the declarations keep signatures only, and
/// past that some tools are left for `codemode.search`.
pub const DESCRIPTION_CAP: usize = 16_000;
const DOC_CHARS: usize = 160;

fn switch_key(project_id: &str) -> String {
    format!("toolsAsCode:{project_id}")
}

fn tools_key(project_id: &str) -> String {
    format!("mcpTools:{project_id}")
}

#[must_use]
pub fn enabled(state: &AppState, project_id: &str) -> bool {
    setting(state, &switch_key(project_id)) == Some(Value::Bool(true))
}

/// `setToolsAsCode [on]` (owner only). Configs change at each agent's next start; the declarations endpoint, and
/// so every running runner, follows the switch at once.
pub fn set_switch(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    save_setting(state, &switch_key(project_id), &json!(args.first().and_then(Value::as_bool) == Some(true)))?;
    crate::integrations::broadcast(state, project_id);
    Ok(())
}

/// One namespace: HQ's own tools (`server` is none) or one tool server's.
#[derive(Debug, Clone)]
pub struct Api {
    pub ns: String,
    pub server: Option<String>,
    pub tools: Vec<ApiTool>,
}

#[derive(Debug, Clone)]
pub struct ApiTool {
    pub name: String,
    pub ident: String,
    pub description: String,
    pub schema: Value,
}

fn ident(raw: &str) -> String {
    let mut out: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '$' { c } else { '_' }).collect();
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

/// `base`, or `base_2`, `base_3`… when an earlier name already took it, so two names never share an identifier.
fn unique(base: String, taken: &[&str]) -> String {
    if !taken.contains(&base.as_str()) {
        return base;
    }
    (2..).map(|n| format!("{base}_{n}")).find(|c| !taken.contains(&c.as_str())).unwrap_or(base)
}

impl Api {
    fn new(ns: String, server: Option<String>, tools: &[Value]) -> Self {
        let mut out: Vec<ApiTool> = Vec::new();
        for t in tools {
            let Some(name) = t["name"].as_str() else { continue };
            let id = unique(ident(name), &out.iter().map(|o| o.ident.as_str()).collect::<Vec<_>>());
            out.push(ApiTool { name: name.to_owned(), ident: id, description: t["description"].as_str().unwrap_or("").to_owned(), schema: t["inputSchema"].clone() });
        }
        Self { ns, server, tools: out }
    }
}

/// HQ's own tools, as `tools/list` shows them.
#[must_use]
pub fn hq_tools() -> Vec<Value> {
    TOOLS.iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.input_schema)() })).collect()
}

/// Namespaces from `(server, tools)` pairs, HQ's own first. `search` is the runner's, so no namespace takes it.
#[must_use]
pub fn apis(servers: &[(Option<String>, Vec<Value>)]) -> Vec<Api> {
    let mut out: Vec<Api> = Vec::new();
    for (server, tools) in servers {
        let taken: Vec<&str> = out.iter().map(|a| a.ns.as_str()).chain(["search"]).collect();
        let ns = unique(ident(server.as_deref().unwrap_or("arima")), &taken);
        out.push(Api::new(ns, server.clone(), tools));
    }
    out
}

/// What this agent may call: HQ's tools, then each registered, unblocked server ticked on its seat that has a stored
/// tool list. A ticked server never checked yet has no declarations until its first check.
#[must_use]
pub fn catalog(state: &AppState, caller: &McpCaller) -> Vec<Api> {
    let ticked: Vec<String> = crate::team::load(state, &caller.project_id)
        .and_then(|m| m.team.iter().find(|a| a["id"] == caller.agent_id.as_str()).map(|a| a["mcp"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()))
        .unwrap_or_default();
    let stored = setting(state, &tools_key(&caller.project_id)).unwrap_or_default();
    let servers = tool_servers(state, &caller.project_id)
        .into_iter()
        .filter(|s| s.blocked.is_none() && ticked.contains(&s.name))
        .filter_map(|s| Some((Some(s.name.clone()), stored[&s.name].as_array()?.clone())));
    apis(&std::iter::once((None, hq_tools())).chain(servers).collect::<Vec<_>>())
}

// ---------------------------------------------------------------- declarations

fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ").replace("*/", "* /");
    if flat.chars().count() <= max {
        return flat;
    }
    format!("{}…", flat.chars().take(max - 1).collect::<String>())
}

fn is_ident(key: &str) -> bool {
    !key.is_empty() && ident(key) == key
}

fn union(parts: Vec<String>) -> String {
    let mut seen: Vec<String> = Vec::new();
    for p in parts {
        if !seen.contains(&p) {
            seen.push(p);
        }
    }
    if seen.is_empty() {
        "any".into()
    } else {
        seen.join(" | ")
    }
}

/// A JSON Schema as a compact TypeScript type. Anything it can't express (a `$ref`, deep nesting) becomes `any`.
#[must_use]
pub fn ts_type(schema: &Value, docs: bool) -> String {
    ts(schema, docs, 0)
}

fn ts(schema: &Value, docs: bool, depth: usize) -> String {
    if depth > 6 || !schema.is_object() {
        return "any".into();
    }
    if let Some(c) = schema.get("const") {
        return c.to_string();
    }
    if let Some(values) = schema["enum"].as_array().filter(|e| !e.is_empty()) {
        return union(values.iter().map(Value::to_string).collect());
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(alts) = schema[key].as_array() {
            return union(alts.iter().map(|a| ts(a, docs, depth + 1)).collect());
        }
    }
    if let Some(all) = schema["allOf"].as_array() {
        return all.iter().map(|a| format!("({})", ts(a, docs, depth + 1))).collect::<Vec<_>>().join(" & ");
    }
    let types: Vec<&str> = match &schema["type"] {
        Value::String(t) => vec![t.as_str()],
        Value::Array(list) => list.iter().filter_map(Value::as_str).collect(),
        _ if schema.get("properties").is_some() => vec!["object"],
        _ => Vec::new(),
    };
    union(
        types
            .into_iter()
            .map(|t| match t {
                "string" => "string".into(),
                "number" | "integer" => "number".into(),
                "boolean" => "boolean".into(),
                "null" => "null".into(),
                "array" => {
                    let item = ts(&schema["items"], docs, depth + 1);
                    if item.contains(' ') && !item.starts_with('{') { format!("({item})[]") } else { format!("{item}[]") }
                }
                "object" => object(schema, docs, depth),
                _ => "any".into(),
            })
            .collect(),
    )
}

fn object(schema: &Value, docs: bool, depth: usize) -> String {
    let Some(props) = schema["properties"].as_object().filter(|p| !p.is_empty()) else {
        let extra = &schema["additionalProperties"];
        return format!("Record<string, {}>", if extra.is_object() { ts(extra, docs, depth + 1) } else { "any".into() });
    };
    let required: Vec<&str> = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let fields: Vec<String> = props
        .iter()
        .map(|(key, prop)| {
            let name = if is_ident(key) { key.clone() } else { json!(key).to_string() };
            let optional = if required.contains(&key.as_str()) { "" } else { "?" };
            let doc = prop["description"].as_str().filter(|d| docs && !d.trim().is_empty()).map(|d| format!("/** {} */ ", clip(d, DOC_CHARS))).unwrap_or_default();
            format!("{doc}{name}{optional}: {}", ts(prop, docs, depth + 1))
        })
        .collect();
    format!("{{ {} }}", fields.join("; "))
}

/// One tool's declaration inside its namespace block.
fn function(tool: &ApiTool, docs: bool) -> String {
    let doc = if docs && !tool.description.trim().is_empty() { format!("/** {} */\n  ", clip(&tool.description, 400)) } else { String::new() };
    let args = if tool.schema.is_object() { ts(&tool.schema, docs, 0) } else { "{}".into() };
    format!("{doc}function {}(args: {args}): Promise<any>;", tool.ident)
}

fn blocks(apis: &[Api], docs: bool, budget: usize) -> (String, usize) {
    let mut out = String::new();
    let mut left_out = 0;
    for api in apis {
        let mut block = format!("declare namespace codemode.{} {{\n", api.ns);
        let mut any = false;
        for tool in &api.tools {
            let line = format!("  {}\n", function(tool, docs));
            if out.len() + block.len() + line.len() + 2 > budget {
                left_out += 1;
                continue;
            }
            block.push_str(&line);
            any = true;
        }
        if any {
            out.push_str(&block);
            out.push_str("}\n");
        }
    }
    (out, left_out)
}

/// The `codemode` tool's description: how to write a run, then the declarations, kept under [`DESCRIPTION_CAP`].
/// The runner adds its limits, which it alone enforces.
#[must_use]
pub fn description(apis: &[Api]) -> String {
    let head = "Run JavaScript that calls your tools as code, in a fresh sandbox. Send an async arrow function or plain \
statements; the function's return value, or the last expression, is the result. `await` each call. Only the codemode \
calls declared below reach outside the sandbox: there is no fetch, network, file system, process or import. \
console.log lines come back as logs.";
    let search = "\n`await codemode.search(\"words\")` returns the matching tools with their descriptions and full declarations.";
    let fence = |decls: &str| format!("\n```ts\n{decls}```");
    let (full, _) = blocks(apis, true, usize::MAX);
    if head.len() + full.len() + 8 <= DESCRIPTION_CAP {
        return format!("{head}{}", fence(&full));
    }
    let note = format!("{search} Declarations below are signatures only.");
    let budget = DESCRIPTION_CAP.saturating_sub(head.len() + note.len() + 120);
    let (sigs, left_out) = blocks(apis, false, budget);
    let more = if left_out > 0 { format!("\n{left_out} more tools aren't listed here; find them with codemode.search.") } else { String::new() };
    format!("{head}{note}{more}{}", fence(&sigs))
}

/// Every tool's full declaration, for `codemode.search`.
fn index(apis: &[Api]) -> Value {
    apis.iter()
        .flat_map(|api| api.tools.iter().map(|t| json!({ "name": format!("codemode.{}.{}", api.ns, t.ident), "description": t.description, "declaration": function(t, true) })))
        .collect()
}

/// What the runner needs for one agent: the description, each namespace's server (none for HQ's own) with each
/// identifier's real tool name, and the search index.
#[must_use]
pub fn declarations(apis: &[Api]) -> Value {
    let namespaces: Map<String, Value> = apis
        .iter()
        .map(|a| (a.ns.clone(), json!({ "server": a.server, "tools": a.tools.iter().map(|t| (t.ident.clone(), json!(t.name))).collect::<Map<_, _>>() })))
        .collect();
    json!({ "description": description(apis), "namespaces": namespaces, "index": index(apis) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_tools() -> Vec<Value> {
        serde_json::from_str(include_str!("fixtures/tool-server-21.json")).unwrap()
    }

    /// What a model is sent for one tool today: name, description and input schema.
    fn as_sent(tools: &[Value]) -> String {
        Value::Array(tools.iter().map(|t| json!({ "name": t["name"], "description": t["description"], "input_schema": t["inputSchema"] })).collect()).to_string()
    }

    #[test]
    fn codemode_description_costs_at_most_half_of_todays_tool_definitions() {
        let (hq, server) = (hq_tools(), server_tools());
        let today = as_sent(&hq).len() + as_sent(&server).len();
        let desc = description(&apis(&[(None, hq), (Some("github".into()), server)]));
        let codemode = as_sent(&[json!({ "name": "codemode", "description": desc, "inputSchema": { "type": "object", "properties": { "code": { "type": "string" } }, "required": ["code"] } })]).len();
        println!("today {today} chars, codemode {codemode} chars, {:.0}% saved", 100.0 - 100.0 * codemode as f64 / today as f64);
        if let Ok(dir) = std::env::var("CODEMODE_MEASURE_DIR") {
            std::fs::write(format!("{dir}/today-hq.json"), as_sent(&hq_tools())).unwrap();
            std::fs::write(format!("{dir}/today-server.json"), as_sent(&server_tools())).unwrap();
            std::fs::write(format!("{dir}/codemode.txt"), &desc).unwrap();
        }
        assert!(codemode * 2 <= today, "today {today}, codemode {codemode}");
    }
}
