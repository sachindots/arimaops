// The real data source: a WebSocket to the local HQ server.
// Server → browser: OfficeEvent JSON. Browser → server: { cmd, args }.

import type { OfficeDataSource, OfficeEvent } from "../source";
import { linkLoginDone, markSignedOut } from "../../store/auth";
import { ask } from "../../ui/dialog";

let cmdCounter = 0;

/** `watch`: a read-only feed for the one-building office (no terminal output; the server ignores commands). */
export function createWsSource(project = "", opts: { watch?: boolean } = {}): OfficeDataSource {
  let ws: WebSocket | null = null;
  const queue: string[] = [];

  const send = (cmd: string, ...args: unknown[]) => {
    cmdCounter += 1;
    const msg = JSON.stringify({ id: `c${cmdCounter}`, cmd, args });
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
    else if (queue.length < 200) queue.push(msg);
  };

  // Remote step-up: the server refused a risky command until a TOTP code is entered.
  const ACTION: Record<string, string> = {
    openShell: "Opening a terminal",
    openHostShell: "Opening a terminal",
    sendTerminalInput: "Typing into a terminal",
    runSetupFix: "Running a setup step",
    recreateSandbox: "Recreating a sandbox",
    removeAgent: "Removing an agent",
    updateAgent: "Changing an agent",
    updateRole: "Changing a role",
    updateProjectTemplate: "Changing the team template",
    resyncTemplate: "Re-syncing the team template",
    saveTemplate: "Saving a template",
    importTemplate: "Importing a template",
    promoteLessons: "Promoting lessons to the template",
    setLessonPromotion: "Switching lesson promotion",
    removeLesson: "Removing a lesson from the template",
    addToSuite: "Adding the task to the benchmark suite",
    updateSandbox: "Changing sandbox rules",
    setSecret: "Saving a key",
    saveAccount: "Saving an account",
    testAccountKey: "Checking a key",
    removeAccount: "Removing an account",
    setMemoryExtraction: "Saving the memory extraction setting",
    setLabMode: "Switching lab mode",
    setSpendCaps: "Changing the spend caps",
    setCompany: "Saving the company context",
    addGoal: "Adding the goal",
    updateGoal: "Saving the goal",
    setTaskGoal: "Linking the task to its goal",
    saveConnection: "Saving the connection",
    removeConnection: "Removing the connection",
    checkConnection: "Checking the connection's tools",
    sendProposal: "Sending",
    finishGithubApp: "Creating the GitHub App",
    setTeamMode: "Changing where the team runs",
    decideMemories: "Checking memories",
    keepOutOfMemory: "Keeping a name out of memory",
    removeSecret: "Removing a key",
    setEnvVar: "Saving an app variable",
    removeEnvVar: "Removing an app variable",
    setProxy: "Changing the proxy",
    openEnvFile: "Opening an env file",
    addMcp: "Adding an MCP server",
    removeMcp: "Removing an MCP server",
    authMcp: "Signing in an MCP server",
    answerApproval: "Answering an agent's request",
    resolveAccess: "Answering an access request",
    resolveActionItem: "Closing an action item",
    answerDecision: "Answering a decision",
    recordGate: "Recording a workflow gate",
    commitMeetingMinutes: "Committing meeting minutes",
    updateWorkflow: "Changing the workflow",
    updateProject: "Changing the project",
    forwardPort: "Opening a port",
  };
  let prompting = false;
  const handleStepUp = (ev: Extract<OfficeEvent, { type: "remote.stepup" }>) => {
    if (ev.status === "denied") return void ask.alert("Wrong or reused code", "Try the next code from your authenticator app.");
    if (ev.status !== "required" || prompting) return;
    prompting = true;
    void ask
      .text("Confirm it's you", `${(ev.cmd && ACTION[ev.cmd]) || "This action"} needs the code from your authenticator app on a device away from the server. This device stays confirmed for 24 hours.`, { field: "code", ok: "Confirm" })
      .then((code) => {
        prompting = false;
        if (code) send("elevate", code, ev.cmd, ev.args ?? []);
      });
  };

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      // Each connect() owns its socket and retry loop, so a stale one can't reconnect.
      let active = true;
      let retry = 0;
      let timer: number | null = null;
      let socket: WebSocket | null = null;

      const open = () => {
        if (!active) return;
        onStatus?.(retry ? "reconnecting" : "connecting");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        // The hq_sid cookie from /api/login authenticates (same origin); no token ever goes in the URL.
        const q = new URLSearchParams();
        if (project) q.set("project", project);
        if (opts.watch) q.set("watch", "1");
        const sock = new WebSocket(`${proto}://${location.host}/ws${q.size ? `?${q}` : ""}`);
        socket = sock;
        let opened = false;
        sock.onopen = () => {
          if (!active) return sock.close();
          opened = true;
          retry = 0;
          ws = sock;
          onStatus?.("open");
          while (queue.length) sock.send(queue.shift() as string);
        };
        sock.onmessage = (m) => {
          if (!active) return;
          try {
            const raw = JSON.parse(String(m.data)) as Record<string, unknown>;
            if (raw.type === "remote.stepup") return handleStepUp(raw as unknown as Extract<OfficeEvent, { type: "remote.stepup" }>);
            if (raw.type === "command-ack") {
              onEvent({
                type: "command.ack",
                id: String(raw.id ?? ""),
                ok: Boolean(raw.ok),
                error: typeof raw.error === "string" ? raw.error : null,
              });
              return;
            }
            onEvent(raw as unknown as OfficeEvent);
          } catch {
            /* ignore malformed frames */
          }
        };
        sock.onclose = (ev) => {
          if (ws === sock) ws = null;
          if (!active) return;
          if (ev.code === 4001) {
            active = false;
            onStatus?.("unauthorized");
            markSignedOut();
            return;
          }
          // Never opened, several times in a row: the token or device cookie was rejected (HQ restarted, or the device was revoked).
          onStatus?.(!opened && retry > 2 ? "unauthorized" : "reconnecting");
          retry += 1;
          timer = window.setTimeout(open, Math.min(5000, 400 * retry));
        };
      };
      void linkLoginDone().then(open);

      // Signing in while the socket is waiting out a retry: connect now instead of up to 5 seconds later.
      const nudge = () => {
        if (!active || (socket && socket.readyState <= WebSocket.OPEN)) return; // connecting or open already
        if (timer) window.clearTimeout(timer);
        timer = null;
        retry = 0;
        open();
      };
      window.addEventListener("arima:signed-in", nudge);

      return () => {
        window.removeEventListener("arima:signed-in", nudge);
        active = false;
        if (timer) window.clearTimeout(timer);
        // Closing mid-handshake logs a browser warning; onopen closes it instead.
        if (socket && socket.readyState !== WebSocket.CONNECTING) socket.close();
        if (ws === socket) ws = null;
      };
    },
    sendTerminalInput: (id, data) => send("sendTerminalInput", id, data),
    resizeTerminal: (id, cols, rows) => send("resizeTerminal", id, cols, rows),
    assignTask: (taskId, agentId) => send("assignTask", taskId, agentId),
    setTaskRunsOn: (taskId, cli, model) => send("setTaskRunsOn", taskId, cli, model),
    updateFinding: (id, patch) => send("updateFinding", id, patch),
    sendMessage: (toId, text) => send("sendMessage", toId, text),
    askTeam: (text) => send("askTeam", text),
    setCompany: (text) => send("setCompany", text),
    addGoal: (goal) => send("addGoal", goal),
    updateGoal: (id, patch) => send("updateGoal", id, patch),
    setTaskGoal: (taskId, goalId) => send("setTaskGoal", taskId, goalId),
    saveConnection: (input) => send("saveConnection", input),
    removeConnection: (name) => send("removeConnection", name),
    checkConnection: (name) => send("checkConnection", name),
    sendProposal: (itemId) => send("sendProposal", itemId),
    startAgent: (id) => send("startAgent", id),
    stopAgent: (id) => send("stopAgent", id),
    openWorkspace: (id) => send("openWorkspace", id),
    recreateSandbox: (id) => send("recreateSandbox", id),
    recheckSetup: () => send("recheckSetup"),
    runSetupFix: (id) => send("runSetupFix", id),
    addAgent: (input) => send("addAgent", input),
    updateAgent: (id, patch) => send("updateAgent", id, patch),
    updateRole: (roleId, patch) => send("updateRole", roleId, patch),
    updateProjectTemplate: (template) => send("updateProjectTemplate", template),
    removeAgent: (id, opts) => send("removeAgent", id, opts),
    inspectWorkspace: (id) => send("inspectWorkspace", id),
    updateSandbox: (id, patch) => send("updateSandbox", id, patch),
    setSecret: (id, name, value) => send("setSecret", id, name, value),
    removeSecret: (id, name) => send("removeSecret", id, name),
    setEnvVar: (id, name, value) => send("setEnvVar", id, name, value),
    removeEnvVar: (id, name) => send("removeEnvVar", id, name),
    setProxy: (url) => send("setProxy", url),
    openEnvFile: (id) => send("openEnvFile", id),
    refreshSbx: () => send("refreshSbx"),
    updateWorkflow: (patch) => send("updateWorkflow", patch),
    updateProject: (patch) => send("updateProject", patch),
    createBoard: (title) => send("createBoard", title),
    updateBoard: (id, patch) => send("updateBoard", id, patch),
    completeWelcome: (input) => send("completeWelcome", input),
    openShell: (id) => send("openShell", id),
    closeShell: (id) => send("closeShell", id),
    openHostShell: (dir, fresh) => send("openHostShell", dir, fresh === true),
    closeHostShell: () => send("closeHostShell"),
    forwardPort: (agentId, port) => send("forwardPort", agentId, port),
    unforwardPort: (agentId, port) => send("unforwardPort", agentId, port),
    updateStack: (stack) => send("updateStack", stack),
    resolveActionItem: (id, decision, note) => send("resolveActionItem", id, decision, note),
    saveAccount: (input) => send("saveAccount", input),
    testAccountKey: (provider, secret, requestId) => send("testAccountKey", provider, secret, requestId),
    removeAccount: (id) => send("removeAccount", id),
    setMemoryExtraction: (input) => send("setMemoryExtraction", input),
    setLabMode: (on) => send("setLabMode", on),
    exportTemplate: () => send("exportTemplate"),
    importTemplate: (text) => send("importTemplate", text),
    promoteLessons: () => send("promoteLessons"),
    setLessonPromotion: (on) => send("setLessonPromotion", on),
    removeLesson: (id) => send("removeLesson", id),
    addToSuite: (taskId) => send("addToSuite", taskId),
    setSpendCaps: (caps) => send("setSpendCaps", caps),
    finishGithubApp: (code) => send("finishGithubApp", code),
    setTeamMode: (mode) => send("setTeamMode", mode),
    decideMemories: (itemId, decisions) => send("decideMemories", itemId, decisions),
    keepOutOfMemory: (name) => send("keepOutOfMemory", name),
    refreshMcp: () => send("refreshMcp"),
    addMcp: (input) => send("addMcp", input),
    authMcp: (name) => send("authMcp", name),
    removeMcp: (name) => send("removeMcp", name),
    setAgentMcp: (agentId, names) => send("setAgentMcp", agentId, names),
    answerApproval: (agentId, approvalId, decision) => send("answerApproval", agentId, approvalId, decision),
    resolveAccess: (requestId, decision) => send("resolveAccess", requestId, decision),
    answerDecision: (id, input) => send("answerDecision", id, input),
    recordGate: (taskId, gateId, state, note) => send("recordGate", taskId, gateId, state, note ?? null),
    startMeeting: (input) => send("startMeeting", input),
    joinMeeting: (meetingId, action, voiceEnabled) => send("joinMeeting", meetingId, action ?? "join", voiceEnabled ?? false),
    addMeetingTurn: (meetingId, bodyMarkdown, speakerId, decisionId) => send("addMeetingTurn", meetingId, bodyMarkdown, speakerId ?? "you", decisionId ?? null),
    commitMeetingMinutes: (meetingId, minutes) => send("commitMeetingMinutes", meetingId, minutes),
    submitVisualFeedback: (input) => send("submitVisualFeedback", input),
  };
  return source;
}
