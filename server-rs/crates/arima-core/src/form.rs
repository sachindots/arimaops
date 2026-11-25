// SPDX-License-Identifier: AGPL-3.0-or-later

//! Agent forms: a small UI an agent sends with `ask_user`, checked here against one component table before it is
//! stored, and the owner's answer. The same table writes the `ui` schema agents see and the catalog the Inbox renders.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use ts_rs::TS;

pub const CATALOG_ID: &str = "arimaops:forms/1";
pub const MAX_BYTES: usize = 32 * 1024;
const MAX_COMPONENTS: usize = 60;
const MAX_DEPTH: usize = 6;
const MAX_STRING: usize = 2_000;
const MAX_RICH_STRING: usize = 8_000;
const MAX_OPTIONS: usize = 50;
const MAX_COLUMNS: usize = 8;
const MAX_ROWS: usize = 50;
const MAX_KEY_VALUES: usize = 30;
const MAX_POINTS: usize = 200;
const MAX_BUTTONS: usize = 6;
const MAX_CONTEXT: usize = 20;

/// What the agent sent as `ask_user.ui`, kept as checked JSON so it reaches the renderer unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct FormSpec {
    pub components: Vec<Value>,
    #[ts(type = "{ [key: string]: JsonValue }")]
    pub data: Map<String, Value>,
}

/// What the owner sent back: the pressed button's event and the whole data model at that moment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct FormAnswer {
    pub action: String,
    pub component_id: String,
    pub context: Value,
    pub data: Value,
}

/// The `form` decision payload; `answer` is none while the card is open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct FormPayload {
    pub form: FormSpec,
    #[serde(default)]
    pub answer: Option<FormAnswer>,
}

/// A property's type. "Display" bindings must point at data the form ships; input bindings may create their path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prop {
    Text,
    DynText,
    DynRichText,
    DynNumber,
    BindText,
    BindList,
    Bool,
    Children,
    Options,
    Columns,
    Rows,
    KeyValues,
    Points,
    Buttons,
    Enum(&'static [&'static str]),
}

pub struct PropDef {
    pub name: &'static str,
    pub kind: Prop,
    pub required: bool,
    pub doc: &'static str,
}

pub struct ComponentDef {
    pub name: &'static str,
    pub doc: &'static str,
    pub props: &'static [PropDef],
}

const fn p(name: &'static str, kind: Prop, required: bool, doc: &'static str) -> PropDef {
    PropDef { name, kind, required, doc }
}

/// The catalog: every component an agent form may use, and its properties.
pub const CATALOG: &[ComponentDef] = &[
    ComponentDef { name: "Column", doc: "Stacks its children top to bottom.", props: &[p("children", Prop::Children, true, "Child component ids, in order.")] },
    ComponentDef {
        name: "Text",
        doc: "Plain text, no Markdown.",
        props: &[p("text", Prop::DynText, true, "The text."), p("variant", Prop::Enum(&["body", "heading", "caption"]), false, "Defaults to body.")],
    },
    ComponentDef {
        name: "TextField",
        doc: "A text input.",
        props: &[
            p("label", Prop::Text, true, "Visible label."),
            p("value", Prop::BindText, true, "Where the answer goes."),
            p("placeholder", Prop::Text, false, "Hint shown while empty."),
            p("multiline", Prop::Bool, false, "Several lines."),
        ],
    },
    ComponentDef {
        name: "Select",
        doc: "Pick one option from a menu.",
        props: &[p("label", Prop::Text, true, "Visible label."), p("options", Prop::Options, true, "The choices."), p("value", Prop::BindText, true, "Where the picked value goes.")],
    },
    ComponentDef {
        name: "CheckList",
        doc: "Option rows to tick: one, or several when multi.",
        props: &[
            p("label", Prop::Text, true, "Visible label."),
            p("options", Prop::Options, true, "The choices."),
            p("values", Prop::BindList, true, "Where the ticked values go (a list)."),
            p("multi", Prop::Bool, false, "Allow several. Defaults to false."),
        ],
    },
    ComponentDef {
        name: "Table",
        doc: "A read-only table.",
        props: &[p("columns", Prop::Columns, true, "Column headings."), p("rows", Prop::Rows, true, "Rows of cells (text or numbers).")],
    },
    ComponentDef { name: "ButtonRow", doc: "Buttons that submit the form.", props: &[p("buttons", Prop::Buttons, true, "One or more buttons.")] },
    ComponentDef {
        name: "Meter",
        doc: "A bar showing value of max.",
        props: &[p("label", Prop::Text, true, "Visible label."), p("value", Prop::DynNumber, true, "Current value."), p("max", Prop::DynNumber, true, "Full scale.")],
    },
    ComponentDef { name: "Chart", doc: "A small line chart.", props: &[p("label", Prop::Text, true, "Visible label."), p("points", Prop::Points, true, "Values, oldest first.")] },
    ComponentDef { name: "Markdown", doc: "Markdown rendered safely without raw HTML.", props: &[p("text", Prop::DynRichText, true, "Markdown text.")] },
    ComponentDef { name: "KeyValue", doc: "Read-only label and value rows.", props: &[p("rows", Prop::KeyValues, true, "Label and value pairs.")] },
    ComponentDef {
        name: "Code",
        doc: "Monospace code or command block, never executed.",
        props: &[p("code", Prop::DynRichText, true, "Monospace text."), p("label", Prop::Text, false, "Optional heading above the block.")],
    },
];

#[must_use]
pub fn component(name: &str) -> Option<&'static ComponentDef> {
    CATALOG.iter().find(|c| c.name == name)
}

/// One problem in a form, at a JSON pointer into the `ask_user` arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for FormError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

fn binding_schema() -> Value {
    json!({ "type": "object", "properties": { "@path": { "type": "string", "description": "JSON pointer into data, e.g. /name." } }, "required": ["@path"], "additionalProperties": false })
}

fn option_schema() -> Value {
    json!({ "type": "array", "maxItems": MAX_OPTIONS, "items": { "type": "object", "properties": { "value": { "type": "string" }, "label": { "type": "string" }, "description": { "type": "string" } }, "required": ["value", "label"], "additionalProperties": false } })
}

fn prop_schema(kind: Prop) -> Value {
    let text = json!({ "type": "string" });
    match kind {
        Prop::Text => text,
        Prop::DynText | Prop::DynRichText => json!({ "anyOf": [text, binding_schema()] }),
        Prop::DynNumber => json!({ "anyOf": [{ "type": "number" }, binding_schema()] }),
        Prop::BindText | Prop::BindList => binding_schema(),
        Prop::Bool => json!({ "type": "boolean" }),
        Prop::Children => json!({ "type": "array", "items": text }),
        Prop::Options => option_schema(),
        Prop::Columns => json!({ "type": "array", "maxItems": MAX_COLUMNS, "items": text }),
        Prop::Rows => json!({ "anyOf": [{ "type": "array", "maxItems": MAX_ROWS, "items": { "type": "array", "items": { "type": ["string", "number"] } } }, binding_schema()] }),
        Prop::KeyValues => json!({
            "anyOf": [
                {
                    "type": "array",
                    "maxItems": MAX_KEY_VALUES,
                    "items": {
                        "type": "object",
                        "properties": { "label": { "type": "string" }, "value": { "type": "string" } },
                        "required": ["label", "value"],
                        "additionalProperties": false
                    }
                },
                binding_schema()
            ]
        }),
        Prop::Points => json!({ "anyOf": [{ "type": "array", "maxItems": MAX_POINTS, "items": { "type": "number" } }, binding_schema()] }),
        Prop::Buttons => json!({
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_BUTTONS,
            "items": {
                "type": "object",
                "properties": {
                    "label": text,
                    "variant": { "enum": ["primary", "default"] },
                    "action": { "type": "object", "properties": { "event": { "type": "object", "properties": { "name": text, "context": { "type": "object" } }, "required": ["name"], "additionalProperties": false } }, "required": ["event"], "additionalProperties": false }
                },
                "required": ["label", "action"],
                "additionalProperties": false
            }
        }),
        Prop::Enum(values) => json!({ "enum": values }),
    }
}

fn component_schema(def: &ComponentDef, with_id: bool) -> Value {
    let mut props = Map::new();
    let mut required = Vec::new();
    if with_id {
        props.insert("id".into(), json!({ "type": "string" }));
        required.push("id");
    }
    props.insert("component".into(), json!({ "const": def.name }));
    required.push("component");
    for prop in def.props {
        let mut schema = prop_schema(prop.kind);
        schema["description"] = json!(prop.doc);
        props.insert(prop.name.into(), schema);
        if prop.required {
            required.push(prop.name);
        }
    }
    json!({ "type": "object", "description": def.doc, "properties": props, "required": required })
}

/// The `ui` input schema `ask_user` advertises: one inline object per component, no `$ref`.
#[must_use]
pub fn ui_schema() -> Value {
    json!({
        "type": "object",
        "description": "An agent form instead of questions. Flat components list (one has id \"root\"); inputs bind {\"@path\": \"/x\"} into data; a ButtonRow button submits.",
        "properties": {
            "components": { "type": "array", "maxItems": MAX_COMPONENTS, "items": { "anyOf": CATALOG.iter().map(|c| component_schema(c, true)).collect::<Vec<_>>() } },
            "data": { "type": "object", "description": "Initial values the components bind to." }
        },
        "required": ["components"]
    })
}

/// The catalog in the renderer's catalog format, exported next to the generated TypeScript types.
#[must_use]
pub fn catalog_json() -> Value {
    let components: Map<String, Value> = CATALOG.iter().map(|c| (c.name.to_string(), component_schema(c, false))).collect();
    json!({
        "catalogId": CATALOG_ID,
        "protocolVersion": "1.0",
        "title": "Agent forms",
        "components": components,
        "$defs": {
            "anyComponent": { "oneOf": CATALOG.iter().map(|c| json!({ "$ref": format!("#/components/{}", c.name) })).collect::<Vec<_>>() },
            "anyFunction": false
        }
    })
}

fn is_id(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

struct Check<'a> {
    data: &'a Value,
    errors: Vec<FormError>,
    buttons: usize,
}

impl<'a> Check<'a> {
    fn err(&mut self, path: &str, message: impl Into<String>) {
        self.errors.push(FormError { path: path.to_string(), message: message.into() });
    }

    fn text(&mut self, path: &str, v: &Value) -> bool {
        self.text_with_limit(path, v, MAX_STRING)
    }

    fn rich_text(&mut self, path: &str, v: &Value) -> bool {
        self.text_with_limit(path, v, MAX_RICH_STRING)
    }

    fn text_with_limit(&mut self, path: &str, v: &Value, max_chars: usize) -> bool {
        match v.as_str() {
            Some(s) if s.chars().count() > max_chars => self.err(path, format!("text longer than {max_chars} characters")),
            Some(_) => return true,
            None => self.err(path, "expected text"),
        }
        false
    }

    /// A `{"@path": "/x"}` binding: its target, or none for a missing path; `Err` when `v` isn't a binding at all.
    fn binding(&mut self, path: &str, v: &Value) -> Result<Option<&'a Value>, ()> {
        let Some(obj) = v.as_object() else { return Err(()) };
        if obj.contains_key("@call") {
            self.err(path, "function calls are not allowed");
            return Ok(None);
        }
        let pointer = match (obj.len(), obj.get("@path").and_then(Value::as_str)) {
            (1, Some(ptr)) => ptr,
            _ => return Err(()),
        };
        if !pointer.starts_with('/') {
            self.err(&format!("{path}/@path"), "expected a JSON pointer starting with /");
            return Ok(None);
        }
        Ok(self.data.pointer(pointer))
    }

    /// A literal, or a binding to data the form already ships.
    fn shown(&mut self, path: &str, v: &Value, ok: fn(&mut Self, &str, &Value) -> bool, expected: &str) {
        let before = self.errors.len();
        match self.binding(path, v) {
            Err(()) => {
                ok(self, path, v);
            }
            Ok(Some(target)) => {
                if !ok(self, path, target) {
                    self.errors.truncate(before);
                    self.err(path, format!("the bound data is not {expected}"));
                }
            }
            Ok(None) if self.errors.len() == before => self.err(path, "binds a path that is missing from data"),
            Ok(None) => {}
        }
    }

    fn input(&mut self, path: &str, v: &Value, list: bool) {
        let target = match self.binding(path, v) {
            Err(()) => return self.err(path, "expected a binding {\"@path\": \"/name\"}"),
            Ok(target) => target,
        };
        let fits = match target {
            None => true,
            Some(Value::String(_)) => !list,
            Some(Value::Array(items)) => list && items.iter().all(Value::is_string),
            Some(_) => false,
        };
        if !fits {
            self.err(path, if list { "the bound data is not a list of text" } else { "the bound data is not text" });
        }
    }

    fn number(&mut self, path: &str, v: &Value) -> bool {
        if v.is_number() {
            return true;
        }
        self.err(path, "expected a number");
        false
    }

    fn list<'v>(&mut self, path: &str, v: &'v Value, max: usize, what: &str) -> Option<&'v Vec<Value>> {
        match v.as_array() {
            None => self.err(path, format!("expected a list of {what}")),
            Some(items) if items.len() > max => self.err(path, format!("more than {max} {what}")),
            Some(items) => return Some(items),
        }
        None
    }

    fn rows(&mut self, path: &str, v: &Value) -> bool {
        let before = self.errors.len();
        for (i, row) in self.list(path, v, MAX_ROWS, "rows").into_iter().flatten().enumerate() {
            let at = format!("{path}/{i}");
            for (j, cell) in self.list(&at, row, MAX_COLUMNS, "cells").into_iter().flatten().enumerate() {
                if !cell.is_number() {
                    self.text(&format!("{at}/{j}"), cell);
                }
            }
        }
        self.errors.len() == before
    }

    fn key_values(&mut self, path: &str, v: &Value) -> bool {
        let before = self.errors.len();
        let Some(items) = self.list(path, v, MAX_KEY_VALUES, "rows") else { return false };
        for (i, item) in items.iter().enumerate() {
            let at = format!("{path}/{i}");
            let Some(obj) = item.as_object().filter(|o| o.get("label").is_some_and(Value::is_string) && o.get("value").is_some_and(Value::is_string)) else {
                self.err(&at, "expected {label, value}");
                continue;
            };
            for (key, field) in obj {
                match key.as_str() {
                    "label" | "value" => {
                        self.text(&format!("{at}/{key}"), field);
                    }
                    _ => self.err(&format!("{at}/{key}"), "unknown row field"),
                }
            }
        }
        self.errors.len() == before
    }

    fn points(&mut self, path: &str, v: &Value) -> bool {
        let before = self.errors.len();
        for (i, point) in self.list(path, v, MAX_POINTS, "points").into_iter().flatten().enumerate() {
            self.number(&format!("{path}/{i}"), point);
        }
        self.errors.len() == before
    }

    fn shown_text(&mut self, path: &str, v: &Value) -> bool {
        v.is_number() || self.text(path, v)
    }

    fn options(&mut self, path: &str, v: &Value) {
        let Some(items) = self.list(path, v, MAX_OPTIONS, "options") else { return };
        if items.is_empty() {
            return self.err(path, "needs at least one option");
        }
        let mut seen = HashSet::new();
        for (i, item) in items.iter().enumerate() {
            let at = format!("{path}/{i}");
            let Some(obj) = item.as_object().filter(|o| o.get("value").is_some_and(Value::is_string) && o.get("label").is_some_and(Value::is_string)) else {
                self.err(&at, "expected {value, label}");
                continue;
            };
            for (key, field) in obj {
                match key.as_str() {
                    "value" | "label" | "description" => {
                        self.text(&format!("{at}/{key}"), field);
                    }
                    _ => self.err(&format!("{at}/{key}"), "unknown option field"),
                }
            }
            if !seen.insert(obj["value"].as_str().unwrap_or_default()) {
                self.err(&format!("{at}/value"), "duplicate option value");
            }
        }
    }

    fn buttons(&mut self, path: &str, v: &Value) {
        let Some(items) = self.list(path, v, MAX_BUTTONS, "buttons") else { return };
        if items.is_empty() {
            return self.err(path, "needs at least one button");
        }
        for (i, item) in items.iter().enumerate() {
            let at = format!("{path}/{i}");
            let Some(obj) = item.as_object() else {
                self.err(&at, "expected {label, action}");
                continue;
            };
            for key in obj.keys().filter(|k| !["label", "variant", "action"].contains(&k.as_str())) {
                self.err(&format!("{at}/{key}"), "unknown button field");
            }
            match obj.get("label") {
                Some(label) => {
                    self.text(&format!("{at}/label"), label);
                }
                None => self.err(&at, "missing label"),
            }
            if let Some(variant) = obj.get("variant") {
                if !matches!(variant.as_str(), Some("primary" | "default")) {
                    self.err(&format!("{at}/variant"), "expected one of primary, default");
                }
            }
            self.action(&format!("{at}/action"), obj.get("action"));
            self.buttons += 1;
        }
    }

    fn action(&mut self, path: &str, v: Option<&Value>) {
        let Some(obj) = v.and_then(Value::as_object) else {
            return self.err(path, "expected {event: {name}}");
        };
        if obj.contains_key("functionCall") {
            return self.err(&format!("{path}/functionCall"), "local functions are not allowed; use {event: {name}}");
        }
        let event = obj.get("event").and_then(Value::as_object);
        let Some(event) = event.filter(|_| obj.len() == 1) else {
            return self.err(path, "expected {event: {name}}");
        };
        let at = format!("{path}/event");
        for key in event.keys().filter(|k| !["name", "context"].contains(&k.as_str())) {
            self.err(&format!("{at}/{key}"), "unknown event field");
        }
        match event.get("name") {
            Some(name) => {
                self.text(&format!("{at}/name"), name);
            }
            None => self.err(&at, "missing name"),
        }
        let Some(context) = event.get("context") else { return };
        let Some(context) = context.as_object() else {
            return self.err(&format!("{at}/context"), "expected an object");
        };
        if context.len() > MAX_CONTEXT {
            self.err(&format!("{at}/context"), format!("more than {MAX_CONTEXT} entries"));
        }
        for (key, value) in context {
            let path = format!("{at}/context/{key}");
            match value {
                Value::String(_) => {
                    self.text(&path, value);
                }
                Value::Null | Value::Bool(_) | Value::Number(_) => {}
                _ => {
                    if self.binding(&path, value).is_err() {
                        self.err(&path, "expected text, a number, true/false or {\"@path\": ...}");
                    }
                }
            }
        }
    }

    fn accessibility(&mut self, path: &str, v: &Value) {
        let Some(obj) = v.as_object() else { return self.err(path, "expected {label, description}") };
        for (key, value) in obj {
            let at = format!("{path}/{key}");
            match key.as_str() {
                "label" | "description" => self.shown(&at, value, Self::text, "text"),
                "live" if matches!(value.as_str(), Some("off" | "polite" | "assertive")) => {}
                _ => self.err(&at, "allowed: label, description, live"),
            }
        }
    }

    fn prop(&mut self, path: &str, kind: Prop, v: &Value) {
        match kind {
            Prop::Text => {
                self.text(path, v);
            }
            Prop::DynText => self.shown(path, v, Self::shown_text, "text"),
            Prop::DynRichText => self.shown(path, v, Self::rich_text, "text"),
            Prop::DynNumber => self.shown(path, v, Self::number, "a number"),
            Prop::BindText => self.input(path, v, false),
            Prop::BindList => self.input(path, v, true),
            Prop::Bool if v.is_boolean() => {}
            Prop::Bool => self.err(path, "expected true or false"),
            Prop::Children => {
                for (i, id) in self.list(path, v, MAX_COMPONENTS, "component ids").into_iter().flatten().enumerate() {
                    if !id.is_string() {
                        self.err(&format!("{path}/{i}"), "expected a component id");
                    }
                }
            }
            Prop::Options => self.options(path, v),
            Prop::Columns => {
                if let Some(cols) = self.list(path, v, MAX_COLUMNS, "columns") {
                    for (i, col) in cols.iter().enumerate() {
                        self.text(&format!("{path}/{i}"), col);
                    }
                }
            }
            Prop::Rows => self.shown(path, v, Self::rows, "a list of rows"),
            Prop::KeyValues => self.shown(path, v, Self::key_values, "a list of key-value rows"),
            Prop::Points => self.shown(path, v, Self::points, "a list of numbers"),
            Prop::Buttons => self.buttons(path, v),
            Prop::Enum(values) if v.as_str().is_some_and(|s| values.contains(&s)) => {}
            Prop::Enum(values) => self.err(path, format!("expected one of {}", values.join(", "))),
        }
    }
}

/// Checks `ask_user.ui`. Errors carry JSON pointers from the tool's arguments, e.g. `/ui/components/3/options/0`.
pub fn validate(ui: &Value) -> Result<FormSpec, Vec<FormError>> {
    let fail = |path: &str, message: &str| Err(vec![FormError { path: path.into(), message: message.into() }]);
    let Some(obj) = ui.as_object() else { return fail("/ui", "expected {components, data}") };
    if serde_json::to_string(ui).map_or(0, |s| s.len()) > MAX_BYTES {
        return fail("/ui", "larger than 32 KiB");
    }
    if let Some(key) = obj.keys().find(|k| !["components", "data"].contains(&k.as_str())) {
        return fail(&format!("/ui/{key}"), "unknown field; expected components and data");
    }
    let data = match obj.get("data") {
        None => Value::Object(Map::new()),
        Some(d) if d.is_object() => d.clone(),
        Some(_) => return fail("/ui/data", "expected an object"),
    };
    let Some(components) = obj.get("components").and_then(Value::as_array) else { return fail("/ui/components", "expected a list of components") };
    if components.is_empty() || components.len() > MAX_COMPONENTS {
        return fail("/ui/components", &format!("expected 1 to {MAX_COMPONENTS} components"));
    }

    let mut check = Check { data: &data, errors: Vec::new(), buttons: 0 };
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut children: Vec<(usize, Vec<&str>)> = Vec::new();
    for (i, c) in components.iter().enumerate() {
        let at = format!("/ui/components/{i}");
        let Some(c) = c.as_object() else {
            check.err(&at, "expected {id, component, ...}");
            continue;
        };
        match c.get("id").and_then(Value::as_str) {
            Some(id) if !is_id(id) => check.err(&format!("{at}/id"), "ids are letters, digits and _, not starting with a digit"),
            Some(id) if ids.insert(id, i).is_some() => check.err(&format!("{at}/id"), format!("duplicate id `{id}`")),
            Some(_) => {}
            None => check.err(&at, "missing id"),
        }
        let name = c.get("component").and_then(Value::as_str).unwrap_or_default();
        let Some(def) = component(name) else {
            let known: Vec<&str> = CATALOG.iter().map(|d| d.name).collect();
            check.err(&format!("{at}/component"), format!("unknown component; expected one of {}", known.join(", ")));
            continue;
        };
        for (key, value) in c {
            let path = format!("{at}/{key}");
            match key.as_str() {
                "id" | "component" => {}
                "@accessibility" => check.accessibility(&path, value),
                _ => match def.props.iter().find(|p| p.name == key) {
                    Some(prop) => check.prop(&path, prop.kind, value),
                    None => check.err(&path, format!("unknown property for {name}")),
                },
            }
        }
        for prop in def.props.iter().filter(|p| p.required && !c.contains_key(p.name)) {
            check.err(&at, format!("{name} needs `{}`", prop.name));
        }
        if let Some(list) = c.get("children").and_then(Value::as_array) {
            children.push((i, list.iter().filter_map(Value::as_str).collect()));
        }
    }

    // A tree: every child exists and has one parent, and everything hangs from `root`.
    let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut parent: HashMap<usize, usize> = HashMap::new();
    for (i, list) in &children {
        for (j, id) in list.iter().enumerate() {
            let at = format!("/ui/components/{i}/children/{j}");
            match ids.get(id) {
                None => check.err(&at, format!("no component has id `{id}`")),
                Some(_) if *id == "root" => check.err(&at, "root can't be a child"),
                Some(&k) if parent.insert(k, *i).is_some() => check.err(&at, format!("`{id}` already has a parent")),
                Some(&k) => kids.entry(*i).or_default().push(k),
            }
        }
    }
    let mut reached = HashSet::new();
    match ids.get("root") {
        None => check.err("/ui/components", "no component has id `root`"),
        Some(&root) => {
            let mut stack = vec![(root, 1)];
            while let Some((i, depth)) = stack.pop() {
                if !reached.insert(i) {
                    continue;
                }
                if depth > MAX_DEPTH {
                    check.err(&format!("/ui/components/{i}"), format!("nested deeper than {MAX_DEPTH} levels"));
                }
                stack.extend(kids.get(&i).into_iter().flatten().map(|&k| (k, depth + 1)));
            }
            for &i in ids.values().filter(|i| !reached.contains(*i)) {
                check.err(&format!("/ui/components/{i}"), "not reachable from root");
            }
        }
    }
    if check.buttons == 0 {
        check.err("/ui/components", "needs a ButtonRow with at least one button");
    }

    let mut errors = check.errors;
    if errors.is_empty() {
        let Value::Object(data) = data else { unreachable!("checked above") };
        return Ok(FormSpec { components: components.clone(), data });
    }
    errors.sort_by(|a, b| a.path.cmp(&b.path));
    Err(errors)
}

/// Ergonomic HQ-side builder for [`FormSpec`]; validates the constructed tree in debug and test builds.
#[derive(Debug, Clone, Default)]
pub struct Form {
    children: Vec<String>,
    components: Vec<Value>,
    data: Map<String, Value>,
    next_id: usize,
}

impl Form {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}_{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn map_options(options: &[(&str, &str, Option<&str>)]) -> Vec<Value> {
        options
            .iter()
            .map(|(value, label, description)| {
                let mut o = Map::new();
                o.insert("value".into(), json!(value));
                o.insert("label".into(), json!(label));
                if let Some(d) = description.filter(|s| !s.is_empty()) {
                    o.insert("description".into(), json!(d));
                }
                Value::Object(o)
            })
            .collect()
    }

    #[must_use]
    pub fn data(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.data.insert(key.to_owned(), value.into());
        self
    }

    #[must_use]
    pub fn text(mut self, text: &str, variant: Option<&str>) -> Self {
        let id = self.next_id("text");
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert("component".into(), json!("Text"));
        obj.insert("text".into(), json!(text));
        if let Some(v) = variant {
            obj.insert("variant".into(), json!(v));
        }
        self.children.push(id);
        self.components.push(Value::Object(obj));
        self
    }

    #[must_use]
    pub fn markdown(mut self, md: &str) -> Self {
        let id = self.next_id("md");
        self.children.push(id.clone());
        self.components.push(json!({ "id": id, "component": "Markdown", "text": md }));
        self
    }

    #[must_use]
    pub fn key_values(mut self, rows: &[(&str, &str)]) -> Self {
        let id = self.next_id("kv");
        let list: Vec<Value> = rows.iter().map(|(l, v)| json!({ "label": l, "value": v })).collect();
        self.children.push(id.clone());
        self.components.push(json!({ "id": id, "component": "KeyValue", "rows": list }));
        self
    }

    #[must_use]
    pub fn code(mut self, label: Option<&str>, code: &str) -> Self {
        let id = self.next_id("code");
        let mut obj = Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert("component".into(), json!("Code"));
        obj.insert("code".into(), json!(code));
        if let Some(l) = label.filter(|s| !s.is_empty()) {
            obj.insert("label".into(), json!(l));
        }
        self.children.push(id);
        self.components.push(Value::Object(obj));
        self
    }

    #[must_use]
    pub fn text_field(
        mut self,
        label: &str,
        bind_key: &str,
        placeholder: Option<&str>,
        multiline: bool,
        initial: &str,
    ) -> Self {
        let id = self.next_id("field");
        self.data.insert(bind_key.to_owned(), json!(initial));
        let mut obj = Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert("component".into(), json!("TextField"));
        obj.insert("label".into(), json!(label));
        obj.insert("value".into(), json!({ "@path": format!("/{bind_key}") }));
        if let Some(ph) = placeholder {
            obj.insert("placeholder".into(), json!(ph));
        }
        if multiline {
            obj.insert("multiline".into(), json!(true));
        }
        self.children.push(id);
        self.components.push(Value::Object(obj));
        self
    }

    #[must_use]
    pub fn select(
        mut self,
        label: &str,
        bind_key: &str,
        options: &[(&str, &str, Option<&str>)],
        initial: &str,
    ) -> Self {
        let id = self.next_id("select");
        self.data.insert(bind_key.to_owned(), json!(initial));
        self.children.push(id.clone());
        self.components.push(json!({
            "id": id,
            "component": "Select",
            "label": label,
            "options": Self::map_options(options),
            "value": { "@path": format!("/{bind_key}") },
        }));
        self
    }

    #[must_use]
    pub fn check_list(
        mut self,
        label: &str,
        bind_key: &str,
        options: &[(&str, &str, Option<&str>)],
        multi: bool,
        picked: &[&str],
    ) -> Self {
        let id = self.next_id("list");
        self.data.insert(bind_key.to_owned(), json!(picked));
        let mut obj = Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert("component".into(), json!("CheckList"));
        obj.insert("label".into(), json!(label));
        obj.insert("options".into(), Value::Array(Self::map_options(options)));
        obj.insert("values".into(), json!({ "@path": format!("/{bind_key}") }));
        if multi {
            obj.insert("multi".into(), json!(true));
        }
        self.children.push(id);
        self.components.push(Value::Object(obj));
        self
    }

    #[must_use]
    pub fn buttons(mut self, buttons: &[(&str, &str, bool)]) -> Self {
        let id = self.next_id("actions");
        let list: Vec<Value> = buttons
            .iter()
            .map(|(action, label, primary)| {
                let mut b = Map::new();
                b.insert("label".into(), json!(label));
                b.insert("variant".into(), json!(if *primary { "primary" } else { "default" }));
                b.insert("action".into(), json!({ "event": { "name": action } }));
                Value::Object(b)
            })
            .collect();
        self.children.push(id.clone());
        self.components.push(json!({ "id": id, "component": "ButtonRow", "buttons": list }));
        self
    }

    #[must_use]
    pub fn build(self) -> FormSpec {
        let mut components = Vec::with_capacity(self.components.len() + 1);
        components.push(json!({ "id": "root", "component": "Column", "children": self.children }));
        components.extend(self.components);
        let spec = FormSpec { components, data: self.data };
        debug_assert!(
            validate(&json!({ "components": &spec.components, "data": &spec.data })).is_ok(),
            "Form::build produced invalid spec"
        );
        spec
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every component, one of each binding kind.
    fn golden() -> Value {
        json!({
            "components": [
                { "id": "root", "component": "Column", "children": ["intro", "name", "region", "features", "plans", "usage", "trend", "details", "meta", "snippet", "go"] },
                { "id": "intro", "component": "Text", "text": { "@path": "/intro" }, "variant": "heading" },
                { "id": "name", "component": "TextField", "label": "Project name", "value": { "@path": "/name" }, "placeholder": "acme" },
                { "id": "region", "component": "Select", "label": "Region", "options": [{ "value": "eu", "label": "Europe" }, { "value": "us", "label": "US" }], "value": { "@path": "/region" } },
                { "id": "features", "component": "CheckList", "label": "Features", "multi": true, "options": [{ "value": "ocr", "label": "OCR", "description": "Scanned PDFs" }], "values": { "@path": "/features" } },
                { "id": "plans", "component": "Table", "columns": ["Plan", "Cost"], "rows": [["Small", 5], ["Large", 20]] },
                { "id": "usage", "component": "Meter", "label": "Quota", "value": { "@path": "/used" }, "max": 100, "@accessibility": { "label": "Quota used" } },
                { "id": "trend", "component": "Chart", "label": "Uploads", "points": [1, 3, 2, 5] },
                { "id": "go", "component": "ButtonRow", "buttons": [
                    { "label": "Approve", "variant": "primary", "action": { "event": { "name": "approve", "context": { "who": { "@path": "/name" }, "n": 1 } } } },
                    { "label": "Not now", "action": { "event": { "name": "later" } } }
                ] },
                { "id": "details", "component": "Markdown", "text": { "@path": "/details" } },
                { "id": "meta", "component": "KeyValue", "rows": [{ "label": "Tool", "value": "bash" }] },
                { "id": "snippet", "component": "Code", "label": "Command", "code": "ls -la" }
            ],
            "data": { "intro": "Set up uploads", "details": "### Notes\n- Check **ACL**.", "region": "eu", "features": [], "used": 40 }
        })
    }

    #[test]
    fn the_golden_form_passes_and_keeps_its_json() {
        let ui = golden();
        let spec = validate(&ui).expect("golden form is valid");
        assert_eq!(Value::Array(spec.components), ui["components"]);
        assert_eq!(Value::Object(spec.data), ui["data"]);
    }

    #[test]
    fn every_rule_names_its_path() {
        type Edit = fn(&mut Value);
        let rows: &[(&str, Edit, &str, &str)] = &[
            ("not an object", |ui| *ui = json!([]), "/ui", "expected {components, data}"),
            ("too big", |ui| ui["data"]["big"] = json!("x".repeat(MAX_BYTES)), "/ui", "larger than 32 KiB"),
            ("extra top-level field", |ui| ui["theme"] = json!("dark"), "/ui/theme", "unknown field; expected components and data"),
            ("data not an object", |ui| ui["data"] = json!([]), "/ui/data", "expected an object"),
            ("no components", |ui| ui["components"] = json!([]), "/ui/components", "expected 1 to 60 components"),
            ("too many components", |ui| ui["components"] = json!(vec![json!({}); 61]), "/ui/components", "expected 1 to 60 components"),
            ("unknown component", |ui| ui["components"][1]["component"] = json!("Image"), "/ui/components/1/component", "unknown component; expected one of Column, Text, TextField, Select, CheckList, Table, ButtonRow, Meter, Chart, Markdown, KeyValue, Code"),
            ("unknown property", |ui| ui["components"][2]["onChange"] = json!("x"), "/ui/components/2/onChange", "unknown property for TextField"),
            ("catalog override", |ui| ui["components"][2]["@catalogId"] = json!("other"), "/ui/components/2/@catalogId", "unknown property for TextField"),
            ("missing required prop", |ui| { ui["components"][2].as_object_mut().unwrap().remove("label"); }, "/ui/components/2", "TextField needs `label`"),
            ("bad id", |ui| ui["components"][1]["id"] = json!("1st"), "/ui/components/1/id", "ids are letters, digits and _, not starting with a digit"),
            ("duplicate id", |ui| ui["components"][2]["id"] = json!("intro"), "/ui/components/2/id", "duplicate id `intro`"),
            ("missing id", |ui| { ui["components"][1].as_object_mut().unwrap().remove("id"); }, "/ui/components/1", "missing id"),
            ("no root", |ui| ui["components"][0]["id"] = json!("top"), "/ui/components", "no component has id `root`"),
            ("unknown child", |ui| ui["components"][0]["children"][0] = json!("ghost"), "/ui/components/0/children/0", "no component has id `ghost`"),
            ("shared child", |ui| ui["components"][0]["children"][1] = json!("intro"), "/ui/components/0/children/1", "`intro` already has a parent"),
            ("root as child", |ui| ui["components"][0]["children"][0] = json!("root"), "/ui/components/0/children/0", "root can't be a child"),
            ("orphan", |ui| ui["components"][0]["children"] = json!(["name", "region", "features", "plans", "usage", "trend", "details", "meta", "snippet", "go"]), "/ui/components/1", "not reachable from root"),
            ("template children", |ui| ui["components"][0]["children"] = json!({ "componentId": "intro", "path": "/items" }), "/ui/components/0/children", "expected a list of component ids"),
            ("text too long", |ui| ui["components"][2]["label"] = json!("x".repeat(MAX_STRING + 1)), "/ui/components/2/label", "text longer than 2000 characters"),
            ("text not text", |ui| ui["components"][2]["label"] = json!(3), "/ui/components/2/label", "expected text"),
            ("bad enum", |ui| ui["components"][1]["variant"] = json!("title"), "/ui/components/1/variant", "expected one of body, heading, caption"),
            ("bool not bool", |ui| ui["components"][2]["multiline"] = json!("yes"), "/ui/components/2/multiline", "expected true or false"),
            ("display binding to missing data", |ui| ui["components"][1]["text"] = json!({ "@path": "/nothing" }), "/ui/components/1/text", "binds a path that is missing from data"),
            ("display binding to wrong type", |ui| ui["components"][6]["value"] = json!({ "@path": "/intro" }), "/ui/components/6/value", "the bound data is not a number"),
            ("relative pointer", |ui| ui["components"][1]["text"] = json!({ "@path": "intro" }), "/ui/components/1/text/@path", "expected a JSON pointer starting with /"),
            ("function call value", |ui| ui["components"][1]["text"] = json!({ "@call": "formatString", "args": {} }), "/ui/components/1/text", "function calls are not allowed"),
            ("input not bound", |ui| ui["components"][2]["value"] = json!("acme"), "/ui/components/2/value", "expected a binding {\"@path\": \"/name\"}"),
            ("input bound to wrong type", |ui| ui["data"]["region"] = json!(3), "/ui/components/3/value", "the bound data is not text"),
            ("list input bound to text", |ui| ui["data"]["features"] = json!("ocr"), "/ui/components/4/values", "the bound data is not a list of text"),
            ("option shape", |ui| ui["components"][3]["options"][0] = json!("eu"), "/ui/components/3/options/0", "expected {value, label}"),
            ("option extra field", |ui| ui["components"][3]["options"][0]["icon"] = json!("x"), "/ui/components/3/options/0/icon", "unknown option field"),
            ("duplicate option", |ui| ui["components"][3]["options"][1]["value"] = json!("eu"), "/ui/components/3/options/1/value", "duplicate option value"),
            ("no options", |ui| ui["components"][3]["options"] = json!([]), "/ui/components/3/options", "needs at least one option"),
            ("too many options", |ui| ui["components"][3]["options"] = json!((0..51).map(|i| json!({ "value": i.to_string(), "label": "x" })).collect::<Vec<_>>()), "/ui/components/3/options", "more than 50 options"),
            ("too many columns", |ui| ui["components"][5]["columns"] = json!(vec!["c"; 9]), "/ui/components/5/columns", "more than 8 columns"),
            ("too many rows", |ui| ui["components"][5]["rows"] = json!(vec![json!(["a"]); 51]), "/ui/components/5/rows", "more than 50 rows"),
            ("bad cell", |ui| ui["components"][5]["rows"][0][0] = json!({ "x": 1 }), "/ui/components/5/rows/0/0", "expected text"),
            ("too many points", |ui| ui["components"][7]["points"] = json!(vec![1; 201]), "/ui/components/7/points", "more than 200 points"),
            ("point not a number", |ui| ui["components"][7]["points"][0] = json!("1"), "/ui/components/7/points/0", "expected a number"),
            ("local function action", |ui| ui["components"][8]["buttons"][0]["action"] = json!({ "functionCall": { "@call": "openUrl", "args": { "url": "https://x" } } }), "/ui/components/8/buttons/0/action/functionCall", "local functions are not allowed; use {event: {name}}"),
            ("action without event", |ui| ui["components"][8]["buttons"][0]["action"] = json!({}), "/ui/components/8/buttons/0/action", "expected {event: {name}}"),
            ("event without name", |ui| ui["components"][8]["buttons"][1]["action"]["event"] = json!({}), "/ui/components/8/buttons/1/action/event", "missing name"),
            ("call in context", |ui| ui["components"][8]["buttons"][0]["action"]["event"]["context"]["who"] = json!({ "@call": "now" }), "/ui/components/8/buttons/0/action/event/context/who", "function calls are not allowed"),
            ("object in context", |ui| ui["components"][8]["buttons"][0]["action"]["event"]["context"]["who"] = json!({ "a": 1 }), "/ui/components/8/buttons/0/action/event/context/who", "expected text, a number, true/false or {\"@path\": ...}"),
            ("bad variant", |ui| ui["components"][8]["buttons"][0]["variant"] = json!("danger"), "/ui/components/8/buttons/0/variant", "expected one of primary, default"),
            ("too many buttons", |ui| ui["components"][8]["buttons"] = json!(vec![json!({ "label": "x", "action": { "event": { "name": "x" } } }); 7]), "/ui/components/8/buttons", "more than 6 buttons"),
            ("no button", |ui| { ui["components"][0]["children"].as_array_mut().unwrap().pop(); ui["components"].as_array_mut().unwrap().remove(8); }, "/ui/components", "needs a ButtonRow with at least one button"),
            ("bad accessibility", |ui| ui["components"][6]["@accessibility"]["hidden"] = json!(true), "/ui/components/6/@accessibility/hidden", "allowed: label, description, live"),
            ("kv row shape", |ui| ui["components"][10]["rows"][0] = json!("tool=bash"), "/ui/components/10/rows/0", "expected {label, value}"),
            ("kv extra field", |ui| ui["components"][10]["rows"][0]["extra"] = json!("x"), "/ui/components/10/rows/0/extra", "unknown row field"),
            ("too many kv rows", |ui| ui["components"][10]["rows"] = json!(vec![json!({ "label": "k", "value": "v" }); 31]), "/ui/components/10/rows", "more than 30 rows"),
            ("rich text too long", |ui| ui["components"][11]["code"] = json!("x".repeat(MAX_RICH_STRING + 1)), "/ui/components/11/code", "text longer than 8000 characters"),
            ("too deep", |ui| {
                let list = ui["components"].as_array_mut().unwrap();
                for d in 0..6 {
                    list.push(json!({ "id": format!("d{d}"), "component": "Column", "children": if d < 5 { json!([format!("d{}", d + 1)]) } else { json!([]) } }));
                }
                ui["components"][0]["children"].as_array_mut().unwrap().push(json!("d0"));
            }, "/ui/components/17", "nested deeper than 6 levels"),
        ];
        for (rule, edit, path, message) in rows {
            let mut ui = golden();
            edit(&mut ui);
            let errors = validate(&ui).expect_err(rule);
            assert!(
                errors.iter().any(|e| e.path == *path && e.message == *message),
                "{rule}: expected `{path}: {message}`, got {:?}",
                errors.iter().map(ToString::to_string).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn a_cycle_off_the_root_is_unreachable() {
        let mut ui = golden();
        let list = ui["components"].as_array_mut().unwrap();
        list.push(json!({ "id": "a", "component": "Column", "children": ["b"] }));
        list.push(json!({ "id": "b", "component": "Column", "children": ["a"] }));
        let errors = validate(&ui).unwrap_err();
        assert!(errors.iter().any(|e| e.path == "/ui/components/12" && e.message == "not reachable from root"), "{errors:?}");
        assert!(errors.iter().any(|e| e.path == "/ui/components/13" && e.message == "not reachable from root"), "{errors:?}");
    }

    #[test]
    fn form_builder_builds_valid_v1_spec() {
        let spec = Form::new()
            .text("Inspect command", Some("heading"))
            .markdown("**Careful**: deletes temp files.")
            .key_values(&[("Tool", "bash"), ("Scope", "workspace")])
            .code(Some("Command"), "rm -rf ./tmp")
            .text_field("Note", "note", Some("Optional rationale"), false, "")
            .select("Action", "mode", &[("once", "Allow once", None), ("deny", "Deny", Some("Reject call"))], "once")
            .check_list("Flags", "flags", &[("dry", "Dry run", None)], true, &["dry"])
            .buttons(&[("allow-once", "Allow once", true), ("deny", "Deny", false)])
            .build();
        let envelope = json!({
            "version": "1.0",
            "createSurface": {
                "surfaceId": "dec-builder",
                "catalogId": CATALOG_ID,
                "components": spec.components,
                "dataModel": spec.data
            }
        });
        let s = |src: &str| serde_json::from_str::<Value>(src).unwrap();
        let base = "https://a2ui.org/specification/v1_0";
        let registry = jsonschema::Registry::new()
            .add(format!("{base}/common_types.json"), s(include_str!("../testdata/forms-v1/common_types.json")))
            .unwrap()
            .add(format!("{base}/catalog.json"), catalog_json())
            .unwrap()
            .prepare()
            .unwrap();
        let validator = jsonschema::options()
            .with_registry(&registry)
            .build(&s(include_str!("../testdata/forms-v1/agent_to_renderer.json")))
            .unwrap();
        let errors: Vec<String> = validator.iter_errors(&envelope).map(|e| format!("{e}")).collect();
        assert!(errors.is_empty(), "{errors:#?}");
    }

    /// The golden form, as the Inbox sends it to the renderer, against the protocol's own v1.0 schemas.
    #[test]
    fn the_golden_form_conforms_to_the_v1_protocol_schemas() {
        let spec = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        let base = "https://a2ui.org/specification/v1_0";
        let registry = jsonschema::Registry::new()
            .add(format!("{base}/common_types.json"), spec(include_str!("../testdata/forms-v1/common_types.json")))
            .unwrap()
            .add(format!("{base}/catalog.json"), catalog_json())
            .unwrap()
            .prepare()
            .unwrap();
        let validator = |schema: &Value| jsonschema::options().with_registry(&registry).build(schema).unwrap();
        let envelope = validator(&spec(include_str!("../testdata/forms-v1/agent_to_renderer.json")));
        let message = |ui: &Value| json!({ "version": "1.0", "createSurface": { "surfaceId": "dec-1", "catalogId": CATALOG_ID, "components": ui["components"], "dataModel": ui["data"] } });

        let ui = golden();
        let errors: Vec<String> = envelope.iter_errors(&message(&ui)).map(|e| format!("{} at {}", e, e.instance_path())).collect();
        assert!(errors.is_empty(), "{errors:#?}");
        let mut unknown = golden();
        unknown["components"][1]["component"] = json!("Image");
        assert!(!envelope.is_valid(&message(&unknown)), "the catalog, not just the envelope, is checked");

        let catalog_schema = validator(&spec(include_str!("../testdata/forms-v1/catalog_definition.json")));
        let errors: Vec<String> = catalog_schema.iter_errors(&catalog_json()).map(|e| format!("{} at {}", e, e.instance_path())).collect();
        assert!(errors.is_empty(), "{errors:#?}");
    }

    #[test]
    fn the_schema_and_catalog_list_every_component_and_property() {
        let schema = ui_schema();
        let alts = schema["properties"]["components"]["items"]["anyOf"].as_array().unwrap();
        let catalog = catalog_json();
        assert_eq!(alts.len(), CATALOG.len());
        assert!(!schema.to_string().contains("$ref"), "agents' schema stays inline");
        for (def, alt) in CATALOG.iter().zip(alts) {
            assert_eq!(alt["properties"]["component"]["const"], def.name);
            let entry = &catalog["components"][def.name];
            for prop in def.props {
                assert_eq!(alt["properties"][prop.name]["description"], prop.doc);
                assert_eq!(entry["properties"][prop.name], alt["properties"][prop.name]);
                assert_eq!(entry["required"].as_array().unwrap().contains(&json!(prop.name)), prop.required);
            }
        }
    }
}
