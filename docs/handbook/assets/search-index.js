// Client-side search index for the ArimaOps Engineering Handbook (offline-safe, no fetch needed).
window.HANDBOOK_INDEX = [
  {
    page: "index.html",
    section: "01 · Start Here",
    anchor: "mental-model",
    title: "The 4 Core Ideas Behind ArimaOps",
    keywords: "overview server single source of truth gates tmux real CLIs",
    summary: "One Node HQ server, real CLIs in isolated tmux/container/sbx sessions, server truth, and 11 workflow gates."
  },
  {
    page: "index.html",
    section: "01 · Start Here",
    anchor: "system-map",
    title: "Interactive 5-Layer System Architecture",
    keywords: "diagram layers clients http ws runtime sqlite vault sbx containers",
    summary: "Interactive diagram tracing UI, HTTP/WS edge, Project Runtime, SQLite/Vault storage, and agent execution."
  },
  {
    page: "index.html",
    section: "01 · Start Here",
    anchor: "repo-map",
    title: "Repository & ~/.arima Runtime Layout",
    keywords: "bin server src android docker ee scripts arima.db vault.json",
    summary: "Annotated directory map of ~/projects/arimaops and ~/.arima runtime data."
  },
  {
    page: "index.html",
    section: "01 · Start Here",
    anchor: "five-minute-trace",
    title: "How to Read Any Feature in 5 Minutes",
    keywords: "types.ts source.ts office.ts commandPolicy.ts commands.ts tests",
    summary: "Step-by-step trace order across types, WS contract, policy, handler, and tests."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "node-ts-zod",
    title: "Node.js Event Loop, TypeScript & Parse Don't Validate",
    keywords: "zod unhandledRejection main.ts commandPolicy.ts boundary validation",
    summary: "Why Node catches unhandledRejection, how shared TS types work, and Zod edge parsing."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "http-ws-csp",
    title: "HTTP, Cookies, Origins, CSP & WebSockets",
    keywords: "hq_sid origin APP_CSP /ws /api/login security",
    summary: "How HTTP and WebSockets split responsibilities and prevent cross-site leaks."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "react-zustand",
    title: "React 19, Unidirectional Reducers & Zustand Traps",
    keywords: "reduce selector array infinite loop useOffice store",
    summary: "Immutable snapshot reducers and why selectors must never allocate fresh arrays."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "sqlite-wal-fts5",
    title: "SQLite, WAL Mode, Migrations & FTS5",
    keywords: "node:sqlite DatabaseSync WAL full-text search memory_text migrations",
    summary: "Why built-in SQLite WAL + FTS5 replaced external databases."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "pty-tmux",
    title: "Terminals, PTYs, ANSI Codes & tmux",
    keywords: "node-pty xterm.js tmux attach restart survival",
    summary: "How pseudo-terminals render CLIs and why tmux keeps agents alive across HQ restarts."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "docker-proxy",
    title: "Docker Bridges, CONNECT Proxies & iptables",
    keywords: "br-hq 8420 DOCKER-USER egress proxy allowlist containers",
    summary: "How br-hq, HTTP CONNECT tunneling, and DOCKER-USER lock down container egress."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "mcp",
    title: "Model Context Protocol (MCP)",
    keywords: "/mcp server/mcp.ts stateless tools X-HQ-Agent",
    summary: "How AI CLIs call typed HQ tools scoped dynamically by role."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "crypto",
    title: "Applied Cryptography (AES-GCM, HMAC, TOTP, Ed25519)",
    keywords: "vault.ts agentTokenFor remote.ts license.ts encryption signatures",
    summary: "Where AES-256-GCM, HMAC-SHA256, RFC 6238 TOTP, and Ed25519 are used."
  },
  {
    page: "fundamentals.html",
    section: "02 · Fundamentals",
    anchor: "webview-bridge",
    title: "Android WebView Bridges & Deep Links",
    keywords: "WebMessagePort ArimaNative MainActivity PushService arimaops://open",
    summary: "Why WebMessagePort beats @JavascriptInterface and how push deep links jump to screens."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "boot-sequence",
    title: "Server Boot Lifecycle",
    keywords: "arimaops.mjs main.ts scrubEnv migrateHome seedBuiltins startProject",
    summary: "Exact startup order from env scrubbing and DB migrations to listeners."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "command-event-loop",
    title: "Interactive 8-Step Command & Event Loop",
    keywords: "wsSource commandPolicy commands hub reduce remote.stepup",
    summary: "Interactive SVG tracing a command from React button click back to Zustand."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "hub-truth",
    title: "Hub: Single Source of Truth, workState & Redactor",
    keywords: "hub.ts holdForAccess workState redact.ts terminal",
    summary: "How Hub overlays access alerts without losing real state and redacts secret streams."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "storage-architecture",
    title: "Three-Tier Storage Schema & SIGKILL Durability",
    keywords: "db.ts docs.ts arima.db .arima/config.json plan.json docs-test",
    summary: "Machine DB vs per-project DB vs git repo files, plus crash-safe JSON import."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "open-core",
    title: "Command Boundary & Open-Core Seam (ee/)",
    keywords: "ownerIf features.ts license.ts ee/ commandPolicy.ts",
    summary: "Dynamic ownerIf escalation and offline-licensed ee/ plugin loading."
  },
  {
    page: "architecture.html",
    section: "03 · Architecture",
    anchor: "frontend",
    title: "Frontend Architecture (Deck vs CompactApp)",
    keywords: "Deck.tsx CompactApp.tsx OfficeDataSource projectTheme.ts 1000px",
    summary: "Mock vs WS sources, 1000px responsive switch, data-theme accents, and portals."
  },
  {
    page: "agent-engine.html",
    section: "04 · Agent Engine",
    anchor: "dual-engine",
    title: "Terminal Engine vs Stream-JSON Engine",
    keywords: "sessions.ts inbox.ts hooks.ts screen.ts streamEngine.ts streamRunner.ts arima-run.py",
    summary: "Interactive diagram comparing tmux + hooks/screen vs Python stream-json long-polling."
  },
  {
    page: "agent-engine.html",
    section: "04 · Agent Engine",
    anchor: "adapters",
    title: "Per-CLI Adapters & Deduplicated Rules",
    keywords: "adapters.ts agentFiles.ts claude codex agy gemini opencode copilot yolo",
    summary: "How 6 CLIs share one engine via .arima-role.md, hooks, and YOLO flags."
  },
  {
    page: "agent-engine.html",
    section: "04 · Agent Engine",
    anchor: "flow-gates",
    title: "Templates, Flows, 11 Gates, Stalls & Stacked PRs",
    keywords: "gates.ts planner.ts stalls.ts presence.ts owner-away stackBase",
    summary: "Reference for all 11 gate kinds, 2h owner-away approvals, stall replans, and stacked PRs."
  },
  {
    page: "agent-engine.html",
    section: "04 · Agent Engine",
    anchor: "memory-core",
    title: "SQLite FTS5 Memory Core & Privacy Scrubbing",
    keywords: "memory.ts memoryClean.ts forget.ts ledger recall related certify fade",
    summary: "Task/progress ledgers, FTS5 recall, 2-hop related memories, scrubbing, and forgetProject."
  },
  {
    page: "agent-engine.html",
    section: "04 · Agent Engine",
    anchor: "skills-security",
    title: "Skill Packs & Static Security Scanner",
    keywords: "skillPacks.ts skillScan.ts skill-packs.lock.json sha256 unicode prompt injection",
    summary: "Pinned commit downloads, SHA-256 verification, and skillScan.ts blocking rules."
  },
  {
    page: "efficiency.html",
    section: "05 · Efficiency",
    anchor: "token-efficiency",
    title: "Token & Dollar Cost Efficiency",
    keywords: "brief.ts 4k tokens lean mode messageTags freeModels spendCaps overflow",
    summary: "Bounded briefs, lean resets, 3-line messages, free model routing, and spend caps."
  },
  {
    page: "efficiency.html",
    section: "05 · Efficiency",
    anchor: "ram-efficiency",
    title: "RAM & Compute Efficiency",
    keywords: "onDemand.ts fitsInRam SANDBOX_DEFAULT RESERVED_MB 2GB SQLite",
    summary: "On-demand 2-min worker grace, 2GB sandbox defaults, 3GB OS headroom, zero Neo4j."
  },
  {
    page: "efficiency.html",
    section: "05 · Efficiency",
    anchor: "speed-latency",
    title: "Speed & Latency Optimizations",
    keywords: "githubApp webhooks funnel 8443 stackBase stream-json gzip",
    summary: "Tailscale Funnel webhooks, stacked PR parallelism, and stream-json responsiveness."
  },
  {
    page: "efficiency.html",
    section: "05 · Efficiency",
    anchor: "code-quality",
    title: "Code Quality, Invariants & Factory Metrics",
    keywords: "architecture-invariants-test.ts line ceilings scorers.ts metrics.ts suite.ts",
    summary: "Pure-logic separation, automated line caps, 53 test scripts, and task scoring."
  },
  {
    page: "efficiency.html",
    section: "05 · Efficiency",
    anchor: "honest-tradeoffs",
    title: "Honest Tradeoffs & Known Limits",
    keywords: "DNS container GH_TOKEN line limits rate limits single machine",
    summary: "Real constraints: container DNS, tight file ceilings, GH_TOKEN, and provider rate limits."
  },
  {
    page: "operations.html",
    section: "06 · Operations",
    anchor: "running-stopping",
    title: "Starting, Stopping & Inspecting Docker HQ",
    keywords: "docker compose stop down build logs tmux capture-pane dev:hq mock",
    summary: "Exact commands to stop arimaops-hq-1, inspect tmux panes, or run mock UI on :5178."
  },
  {
    page: "operations.html",
    section: "06 · Operations",
    anchor: "desktop-icon",
    title: "Ubuntu Desktop Icon: Why Clicking It Breaks",
    keywords: "arimaops.desktop arimaops-launch.sh server.pid EADDRINUSE projects.json sqlite",
    summary: "Root-cause breakdown of all 3 launcher bugs against Docker HQ and SQLite."
  },
  {
    page: "operations.html",
    section: "06 · Operations",
    anchor: "tablet-integration",
    title: "Tablet & Phone Integration (Android + Tailscale + FCM)",
    keywords: "MainActivity.java PushService.java native.ts push.ts WebMessagePort TOTP",
    summary: "Responsive layout, WebMessagePort bridge, Tailscale HTTPS, and deep-link push alerts."
  },
  {
    page: "operations.html",
    section: "06 · Operations",
    anchor: "security-boundaries",
    title: "Five Defense-in-Depth Security Boundaries",
    keywords: "deliver.ts redact.ts vault.ts scope.ts iptables DOCKER-USER",
    summary: "Browser, Agent HMAC, Host isolation, Engagement scope, and ephemeral 0600 secrets."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-0",
    title: "Lab 0: Inspect the Live System Safely",
    keywords: "docker ps ss sqlite mock 5178 architecture-invariants",
    summary: "Read-only inspection of Docker HQ, ports, SQLite docs, and mock UI."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-1",
    title: "Lab 1: Fix the Ubuntu Desktop Icon Launcher",
    keywords: "arimaops-launch.sh install-desktop.sh health projects.json sqlite",
    summary: "Update the launcher script to detect Docker HQ on :7420 and read SQLite."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-2",
    title: "Lab 2: Trace assignTask Across Every Layer",
    keywords: "TaskSheet officeActions wsSource commandPolicy commands planner hub",
    summary: "Follow one live command end-to-end across UI, WS, policy, handler, and reducer."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-3",
    title: "Lab 3: Add a Typed WebSocket Command",
    keywords: "source.ts commandPolicy.ts commands.ts OfficeDataSource parity",
    summary: "Add a new operator command with Zod schema and verify 1-to-1 invariant parity."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-4",
    title: "Lab 4: Write a Pure Deterministic Scorer Rule",
    keywords: "scorers.ts factory-test pure logic TDD",
    summary: "Implement a zero-I/O task scorer rule and verify it with tests."
  },
  {
    page: "labs.html",
    section: "07 · Labs",
    anchor: "lab-5",
    title: "Lab 5: Add a Role-Scoped MCP Tool & Deck UI",
    keywords: "mcp.ts LEAD_ONLY_TOOLS Deck typography Zustand selector",
    summary: "Register a Lead-only MCP tool and render stats in the Command Deck safely."
  },
  {
    page: "reading.html",
    section: "08 · Reading",
    anchor: "repo-docs",
    title: "Existing Markdown Specs in docs/",
    keywords: "architecture.md core-model.md agent-engine.md memory-core.md templates.md factory.md",
    summary: "Complete index of all 11 existing docs/ files with freshness notes."
  },
  {
    page: "reading.html",
    section: "08 · Reading",
    anchor: "external-library",
    title: "Curated External Reading Library",
    keywords: "Node SQLite WAL FTS5 React Zustand MCP Docker iptables RFC 6238 OWASP Ousterhout",
    summary: "Authoritative external specifications, RFCs, and engineering guides for every layer."
  }
];
