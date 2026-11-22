// SPDX-License-Identifier: AGPL-3.0-or-later

//! Strict origin-checked `ArimaBridge` injection for `text/html` preview responses.
//!
//! Never uses wildcard `"*"` `postMessage` targets: every outbound `postMessage` and inbound
//! command listener is locked strictly to the exact authenticated `hq_origin`.

use url::Url;

/// Validates that `hq_origin` is a strict `http://` or `https://` origin without wildcard or path.
#[must_use]
pub fn normalize_strict_origin(hq_origin: &str) -> Option<String> {
    let trimmed = hq_origin.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "*" {
        return None;
    }
    let u = Url::parse(trimmed).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?;
    let port_part = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{host}{port_part}", u.scheme()))
}

/// Renders the self-contained `ArimaBridge` `<script>` tag locked strictly to `hq_origin`.
///
/// Returns `None` if `hq_origin` is invalid or wildcard `"*"`.
#[must_use]
pub fn render_bridge_script(hq_origin: &str) -> Option<String> {
    let strict_origin = normalize_strict_origin(hq_origin)?;
    // Safely serialize origin as a JS string literal and guard against `</script>` breakout.
    let origin_lit = serde_json::to_string(&strict_origin)
        .ok()?
        .replace("</", "<\\/");

    Some(format!(
        r##"<script data-arima-bridge="1">
(() => {{
  if (window.__ARIMA_BRIDGE_INSTALLED__) return;
  window.__ARIMA_BRIDGE_INSTALLED__ = true;
  const HQ_ORIGIN = {origin_lit};
  let mode = "browse";
  const MAX_ERRORS = 50;
  const errors = [];

  function postToHq(payload) {{
    if (window.parent && window.parent !== window) {{
      window.parent.postMessage(payload, HQ_ORIGIN);
    }}
  }}

  function pushError(level, message, source) {{
    const entry = {{
      level: String(level || "error"),
      message: String(message || "").slice(0, 800),
      source: source ? String(source).slice(0, 300) : null,
      at: new Date().toISOString()
    }};
    errors.push(entry);
    if (errors.length > MAX_ERRORS) errors.shift();
    postToHq({{ type: "arima:console-error", entry }});
  }}

  const origConsoleError = console.error;
  console.error = function (...args) {{
    try {{
      pushError("error", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "), "console.error");
    }} catch (_) {{}}
    return origConsoleError.apply(console, args);
  }};

  window.addEventListener("error", (ev) => {{
    pushError("error", ev.message || "Script error", ev.filename ? `${{ev.filename}}:${{ev.lineno || 0}}` : null);
  }});

  window.addEventListener("unhandledrejection", (ev) => {{
    const msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason || "Unhandled rejection");
    pushError("error", msg, "unhandledrejection");
  }});

  if (typeof window.fetch === "function") {{
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {{
      try {{
        const res = await origFetch(...args);
        if (!res.ok) {{
          const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          pushError("network", `HTTP ${{res.status}} ${{res.statusText}}`, reqUrl);
        }}
        return res;
      }} catch (err) {{
        const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        pushError("network", err && err.message ? err.message : "Network request failed", reqUrl);
        throw err;
      }}
    }};
  }}

  function cssSelectorFor(el) {{
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${{CSS && CSS.escape ? CSS.escape(el.id) : el.id}}`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {{
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {{
        parts.unshift(`#${{cur.id}}`);
        break;
      }}
      const cls = typeof cur.className === "string"
        ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        : [];
      if (cls.length) sel += "." + cls.join(".");
      parts.unshift(sel);
      cur = cur.parentElement;
      depth += 1;
    }}
    return parts.join(" > ");
  }}

  function componentHintFor(el) {{
    if (!el) return null;
    const explicit = el.getAttribute && (el.getAttribute("data-component") || el.getAttribute("data-testid"));
    if (explicit) return explicit;
    for (const k of Object.keys(el)) {{
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {{
        let f = el[k];
        for (let i = 0; i < 8 && f; i += 1) {{
          if (typeof f.type === "function" && f.type.name) return f.type.name;
          f = f.return;
        }}
      }}
    }}
    return null;
  }}

  function buildSelection(el) {{
    const rect = el.getBoundingClientRect();
    return {{
      cssSelector: cssSelectorFor(el),
      tagName: (el.tagName || "div").toLowerCase(),
      ariaRole: el.getAttribute ? el.getAttribute("role") : null,
      componentHint: componentHintFor(el),
      textSnippet: String(el.innerText || el.textContent || "").trim().slice(0, 160),
      outerHtmlSnippet: String(el.outerHTML || "").slice(0, 320),
      bbox: {{
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }}
    }};
  }}

  let highlightBox = null;
  function ensureHighlight() {{
    if (highlightBox) return highlightBox;
    const box = document.createElement("div");
    box.setAttribute("data-arima-overlay", "1");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #22d3ee;background:rgba(34,211,238,0.12);border-radius:4px;display:none;";
    document.documentElement.appendChild(box);
    highlightBox = box;
    return box;
  }}

  function hideHighlight() {{
    if (highlightBox) highlightBox.style.display = "none";
  }}

  document.addEventListener("pointermove", (ev) => {{
    if (mode !== "pick") return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el.getAttribute("data-arima-overlay") === "1") return;
    const sel = buildSelection(el);
    const box = ensureHighlight();
    box.style.display = "block";
    box.style.left = sel.bbox.x + "px";
    box.style.top = sel.bbox.y + "px";
    box.style.width = sel.bbox.width + "px";
    box.style.height = sel.bbox.height + "px";
    postToHq({{ type: "arima:hover", selection: sel }});
  }}, true);

  document.addEventListener("click", (ev) => {{
    if (mode !== "pick") return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el.getAttribute("data-arima-overlay") === "1") return;
    ev.preventDefault();
    ev.stopPropagation();
    const sel = buildSelection(el);
    postToHq({{ type: "arima:pick", selection: sel }});
  }}, true);

  function captureFallbackPng() {{
    const w = Math.max(320, Math.min(window.innerWidth || 1280, 1920));
    const h = Math.max(240, Math.min(window.innerHeight || 800, 1440));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {{
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#0b1220";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "600 18px Inter, sans-serif";
      ctx.fillText(document.title || location.href, 24, 42);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "400 13px Inter, sans-serif";
      ctx.fillText(`${{location.href}} (${{w}}x${{h}})`, 24, 68);
    }}
    let dataUrl = "";
    try {{ dataUrl = canvas.toDataURL("image/png"); }} catch (_) {{}}
    postToHq({{
      type: "arima:snapshot-fallback",
      pageUrl: location.href,
      viewportWidth: w,
      viewportHeight: h,
      imageDataUrl: dataUrl
    }});
  }}

  window.addEventListener("message", (ev) => {{
    if (ev.origin !== HQ_ORIGIN) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "arima:mode" || data.type === "arima:set-mode") {{
      mode = data.mode === "pick" || data.mode === "draw" ? data.mode : "browse";
      if (mode !== "pick") hideHighlight();
    }} else if (data.type === "arima:request-snapshot") {{
      captureFallbackPng();
    }} else if (data.type === "arima:get-errors") {{
      postToHq({{ type: "arima:console-errors", entries: errors.slice() }});
    }}
  }});

  postToHq({{
    type: "arima:ready",
    pageUrl: location.href,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  }});
}})();
</script>"##
    ))
}

/// Injects the origin-locked `ArimaBridge` script into an HTML document before `</body>`
/// (case-insensitive) or `</html>`. Returns original HTML unchanged if `hq_origin` is invalid.
#[must_use]
pub fn inject_bridge_html(html: &str, hq_origin: &str) -> String {
    let Some(script) = render_bridge_script(hq_origin) else {
        return html.to_owned();
    };
    let lower = html.to_ascii_lowercase();
    if let Some(pos) = lower.rfind("</body>") {
        let mut out = String::with_capacity(html.len() + script.len() + 2);
        out.push_str(&html[..pos]);
        out.push_str(&script);
        out.push('\n');
        out.push_str(&html[pos..]);
        return out;
    }
    if let Some(pos) = lower.rfind("</html>") {
        let mut out = String::with_capacity(html.len() + script.len() + 2);
        out.push_str(&html[..pos]);
        out.push_str(&script);
        out.push('\n');
        out.push_str(&html[pos..]);
        return out;
    }
    format!("{html}\n{script}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wildcard_and_injects_strict_origin_bridge() {
        assert!(normalize_strict_origin("*").is_none());
        assert!(normalize_strict_origin("javascript:alert(1)").is_none());
        assert_eq!(
            normalize_strict_origin("http://localhost:7420/").as_deref(),
            Some("http://localhost:7420")
        );

        let html = "<!doctype html><html><body><h1>Demo</h1></body></html>";
        let injected = inject_bridge_html(html, "http://localhost:7497");
        assert!(injected.contains("data-arima-bridge=\"1\""));
        assert!(injected.contains("const HQ_ORIGIN = \"http://localhost:7497\";"));
        assert!(injected.contains("if (ev.origin !== HQ_ORIGIN) return;"));
        assert!(!injected.contains("postMessage(payload, \"*\")"));
        assert!(injected.find("</script>").unwrap() < injected.find("</body>").unwrap());
    }
}
