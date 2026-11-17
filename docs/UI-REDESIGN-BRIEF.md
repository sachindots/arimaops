# ArimaOps UI — Redesign Brief

_Prepared 2026-11-17 · a page-by-page map of the current app for a frontend redesign._

ArimaOps is a self-hosted orchestrator: one local server (**HQ**) runs a **team of AI agents per project**, and this React app is the window into it. A lead plans work, workers build/test/exploit in their own containers, reviewers check each other, and **gates** decide when a task is done. The human watches, steers, and approves what matters — from desktop or phone.

There are **two layouts of the same app**, which the redesign must both cover:
- **Desktop HUD** (≥1000px) — `src/ui/hud/SpatialHud.tsx`: a spatial "command deck" with an agent orbit, a left nav rail, and slide-in drawers.
- **Compact** (<1000px) — `src/ui/compact/CompactApp.tsx`: phone/tablet, a bottom tab bar, drawers become full pages.

> The server is the source of truth. The UI never decides anything that matters; every action is a command the server re-checks. So the redesign is free to restyle anything, but should keep the same actions and the same read-only-vs-operator distinction.

---

## 1. Design language (today)

Keep the spirit unless you deliberately rethink it: an **advanced but readable dark-glass HUD** — corner-bracket panels, glowing meters, sparklines, live counters.

- **Type:** Inter (body), **Space Grotesk** for headings & big numbers only, **JetBrains Mono** for code/IDs. Nothing under 11px (12px for content).
- **Colour:** dark base (`#030712`), **one cyan accent** (`#00f0ff`); status colours used **only** for status (working = cyan, needs-you = amber, error = red, idle = grey). Red is the security/red-team register.
- Tokens live in `src/index.css` (`@theme`). No pixel/game styling; no trademarked names in the UI.
- **Motion** is a signature (orbiting agents, particle core, pulsing meters) but must degrade: everything stays legible with reduced-motion.

---

## 2. Global chrome (every screen)

**Top bar** (desktop) — left to right:
- **Project switcher** (brand + project name) — "Switch, create, or manage projects".
- Live stat readouts: **Working N** (agents busy), **Tasks N**, **Today <tokens> · $<cost>**.
- **"N need you"** pill → opens the Inbox (amber when >0).
- **"Setup · N to do"** → opens the setup checklist.
- **Start all stopped agents** (play).
- **Settings** (gear) · **Sign out**.
- A **demo badge** appears in the mock/demo build.

**Left nav rail** (desktop, `SpatialHud`): **Home · Board · Inbox · Agents · Chat · Flow · PRs · Findings · Usage · Grid · More**. Each item routes to a tab or opens a drawer over the current view.

**Command bar** (`Cmd/Ctrl+K`, `ui/hud/CommandBar.tsx`) — a fuzzy palette jumping to: Task Board, Approvals & Inbox, Security Findings, Flow, Multi-Project Command Grid, agents and tasks by name. **This is a key power-user surface — keep it.**

**Connection banner** (`ConnectionBanner.tsx`) — reconnect state when the WebSocket drops. **Demo banner** — "sample projects running in your browser".

---

## 3. Home — the agent orbit (`SpatialHud`, `AgentOrbit`, `ParticleCore`, `StageStrip`, `TelemetryCorners`)

The signature screen. A **particle core** in the centre reacts to the team's activity; **agent cards orbit** around it.

- **Agent card** (floating): avatar/initial, name, **status** (Working / Idle / Needs input), the **current task + stage**, **tokens today + cost**, a **sparkline**, and quick actions **Terminal · Chat · Usage**. Clicking opens the agent panel (§4).
- **Stage strip** (bottom, `StageStrip`): the flow's stages (e.g. Spec · Plan · Build · Review · Merge) with a **count of tasks in each** — a live mini-board.
- **Telemetry corners**: corner-bracket readouts (team totals, needs-you).
- Summary line: "N agents · N working · N tasks in flight".

**Redesign notes:** the orbit is the brand moment but it's dense and motion-heavy. Priorities: readable agent cards at a glance, a clear "who needs me" signal, and a graceful static fallback.

---

## 4. Agents — roster + agent panel (`AgentDrawer`, `AgentList`)

**Roster** (grid of agent cards): "N in <project>". Each card = name, **role** (Lead / Recon / Exploit / Reporter / Second opinion…), CLI + model + isolation (container/sandbox/local), status, current task (`JSE-T02 Confirm SQLi…`), tokens today + cost, sparkline, and **Terminal · Chat · Usage** buttons.

**Agent panel** (opens on a card) tabs:
- **Terminal** — the agent's live CLI output (read-only feed; `TerminalView`).
- **Chat** — Team-MCP messages to/from the agent ("No messages yet").
- **Usage** — this agent's tokens/cost.
- Controls: **Assign a task**, **Change** (model / mode), **Environment** (Local mode / Container / Docker Sandbox), **Current task** / "No task right now", and a **trust prompt** ("Trust all and continue / Yes") when a CLI asks to trust a folder — *this must stay a deliberate human action.*

---

## 5. Board (`BoardsDrawer`, `TaskSheet`)

A kanban of tasks across the flow's stages (To do / Doing / Review / Done, per template). Columns show how long the oldest task has waited; the board can **group by agent**. Empty = "Nothing here".

**Task sheet** (a task opens): title, **"Done when"** criteria, the **files it touches**, owner (or **Unassigned**), stage, whether it's **high-stakes** / **in suite**, and evidence. The lead writes these; the human can reassign/approve.

---

## 6. Inbox / Approvals (`ActionItemsDrawer`)

**Everything that needs the human, in one place.** Two groups: **"<needs you>"** and **"From agents" / "Also waiting on you"**. Item types seen: **spec · needs approval**, **plan · needs approval**, **spend**, **usage limit**, **template change**, **lesson · for the template**, **skills · scan**, **lead approved · undoable**. Each is an approve/decide card. "All clear" when empty.

**Redesign notes:** this is the operational heart for an operator — make triage fast, make the destructive/irreversible vs undoable distinction obvious, and keep approvals one-tap but not accidental.

---

## 7. Flow (`FlowDrawer`)

The **pipeline editor**: stages, the **roles that work** each stage ("Who works it" / "No roles"), and the **gates** between them (reviewer required, second opinion from another maker's model, screenshots for UI changes, your approval, or **Always**). HQ validates a change before it saves. Read-only view for viewers.

---

## 8. PRs (`PrDrawer`)

Pull requests the team opened: list with review state and **Merged** badges; "No open PRs" when empty. (HQ never merges for you — merge stays a human action.)

---

## 9. Findings — security (`FindingsDrawer`)

The red-team surface. Top: **severity tiles** (Critical / High / Medium / Low / Info counts). Then a **findings table**: Severity · Finding (id + title + endpoint) · Status (confirmed…) · **Verified** · **Agent** · Age. Right rail: **Scope** (in/out of scope, rules of engagement) and **Report** (path + **Export**: Markdown · JSON · SARIF · HackerOne · Bugcrowd). A finding opens to Description · Impact · Evidence · Remediation · SSVC · CWE/ATT&CK/WSTG.

**Redesign notes:** this view doubles as the product's security story — it reads as red/offensive on the marketing site. Keep severity colour-coding meaningful and the export path prominent.

---

## 10. Usage (`UsagePage`, `UsageTab`)

Team tokens and **estimated cost** over a range (Today / …). "Where the tokens went", "Share of the team", a per-agent **leaderboard with sparklines**, and spend **caps** (alert at 80%, pause workers at 100%).

---

## 11. Chat (`ChatList`, `Thread`)

Team chat — threads with agents and the lead. Compose + thread history. (On mobile this is the default tab.)

---

## 12. Grid / Command center (`CommandView`, `Factory`)

**Multi-project** view: every agent of every project in one roster, **needs-you first**. Panels: **Agents** (searchable — "Find agent, task… (/)"), a selected agent's **live terminal** ("Pick an agent on the left"), **Needs you** ("Nothing waits on you"), **Activity** ("Nothing yet"), **Tokens today / Cost**, a **Red team** filter, and **Factory / Template versions**. Pop an agent out to another monitor.

---

## 13. Settings (`SettingsModal` + sections)

A modal with sections: **Project · Team · Workflow · Boards · Stack · Sandbox · Accounts · Users · MCP · Memory · Resources**.
- **Team** — agents, roles, models. **Workflow** — stages/gates (deep version of Flow). **Boards** — starter columns/tasks. **Stack** — the project's tech. **Sandbox** — isolation mode + egress allowlist. **Accounts** — provider credentials (shows "set ✓ ending 1a2b", never the secret). **Users** — owner/operator/viewer, passwords, authenticator. **MCP** — team MCP tools. **Memory** — memory types. **Resources** — RAM/port caps. Plus **Remove agent** confirm dialog.

---

## 14. Setup, Sign-in & roles (`SetupChecklist`, `WelcomeModal`, `TemplateImport`, `SignIn`, `Authenticator`, `OwnerPrompt`)

- **Setup checklist** — what's missing on the machine to run the chosen template, with the exact fix command. (It can overlay the HUD; closable.)
- **Welcome / Template import** — naming a project and picking a template (Dev, Security Red/Purple/Blue, Research, Marketing…).
- **Sign-in** ("HQ ACCESS") — Name + Password, or the start-up token URL. **Authenticator** — TOTP for risky actions from a remote device.
- **Roles**: **owner / operator / viewer**. **Viewer is read-only** — the redesign must express a read-only state for every actionable control.

---

## 15. Compact — phone/tablet (`CompactApp`)

Bottom tab bar: **Chat · Board · Inbox · Agents · More** (+ Home). Drawers (agent, PRs, terminal, findings, flow) open as **full pages** over the current tab. The orbit Home and stage strip are sized for touch. Same data, same actions, smaller canvas — approve a spec, read a terminal, stop a run from anywhere.

---

## 16. States, constraints & where the wins are

**States every screen needs:** loading, **empty** (friendly, e.g. "All clear" / "No open PRs"), error/disconnected (reconnect banner), **read-only** (viewer role), and **needs-you** (amber emphasis).

**Must preserve:**
- The **Command bar (⌘K)** and the **nav set** (Home/Board/Inbox/Agents/Chat/Flow/PRs/Findings/Usage/Grid).
- The **approve/decide** flow and the **undoable vs irreversible** distinction.
- **Status-colour discipline** (one cyan accent; status colours only for status; red = security).
- **Both layouts** (desktop HUD + compact) and reduced-motion fallbacks.
- No merging/typing-secrets/trust-prompt done automatically — those stay human.

**Biggest redesign opportunities:**
1. **Home orbit** — keep the wow, raise glanceability of each agent card and the "who needs me" signal.
2. **Inbox** — make operator triage faster and safer.
3. **Density** — the HUD is information-rich; a clearer hierarchy (primary number, secondary meta) would help every screen.
4. **Findings** — it carries the security story; make severity + export shine.
5. A consistent **agent card** component reused across Home, Agents, and Grid.

**Where to look in code:** nav + home `src/ui/hud/SpatialHud.tsx`; agent cards `src/ui/hud/AgentOrbit.tsx` + `src/ui/compact/CompactApp.tsx`; drawers `src/ui/drawers/*`; settings `src/ui/settings/*`; the data contract (what each screen gets from the server) `src/data/types.ts`. The mock demo (`pnpm dev` against a dead HQ, or the `ui-mock` launch config) renders every screen with sample data — the fastest way to click through all of it.
