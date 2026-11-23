// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_core::ServerRole;

/// Authorization context computed per WS command or HTTP request.
#[derive(Debug, Clone, Copy)]
pub struct AuthContext {
    pub server_role: ServerRole,
    pub project_role: Option<ServerRole>,
    pub remote: bool,
    pub elevated: bool,
    pub target_agent_local: bool,
    pub decision_owner_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandVerdict {
    Allowed,
    Denied(&'static str),
    StepUpRequired,
}

/// Computes effective role: server-wide `Owner` always stays `Owner`;
/// otherwise an explicit per-project binding overrides the user's server default.
#[must_use]
pub fn effective_role(server_role: ServerRole, project_role: Option<ServerRole>) -> ServerRole {
    match server_role {
        ServerRole::Owner => ServerRole::Owner,
        _ => project_role.unwrap_or(server_role),
    }
}

/// Strict command-level RBAC + remote TOTP step-up enforcement.
#[must_use]
pub fn authorize_command(cmd: &str, ctx: &AuthContext) -> CommandVerdict {
    let role = effective_role(ctx.server_role, ctx.project_role);

    if matches!(role, ServerRole::Viewer) {
        return match cmd {
            // refreshMcp is left out: it makes HQ call every MCP server, so it needs an operator.
            "recheckSetup" | "refreshSbx" | "ping" => CommandVerdict::Allowed,
            _ => CommandVerdict::Denied("viewer role is strictly read-only"),
        };
    }

    // Allow-list: an operator may run only these; any new command is owner-only until listed here.
    let operator_ok = matches!(cmd, "ping" | "elevate" | "recheckSetup" | "refreshSbx" | "refreshMcp"
        | "startAgent" | "stopAgent" | "sendMessage" | "askTeam" | "sendTerminalInput" | "resizeTerminal"
        | "closeShell" | "closeHostShell" | "forwardPort" | "unforwardPort" | "openWorkspace" | "inspectWorkspace"
        | "answerDecision" | "resolveDecision" | "resolveActionItem" | "recordGate" | "sendProposal"
        | "answerApproval" | "resolveAccess"
        | "assignTask" | "addGoal" | "updateGoal" | "setTaskGoal" | "setTaskRunsOn" | "updateBoard" | "createBoard"
        | "updateFinding" | "keepOutOfMemory" | "decideMemories"
        | "startMeeting" | "joinMeeting" | "addMeetingTurn" | "commitMeetingMinutes" | "submitVisualFeedback"
        | "updateAgent" | "addAgent" | "setTeamMode" | "updateRole"
        | "setEnvVar" | "removeEnvVar" | "openEnvFile" | "setSecret" | "removeSecret"
        | "exportTemplate" | "checkConnection");
    let owner_only_always = !operator_ok;

    let local_host_escape = matches!(
        cmd,
        "setEnvVar"
            | "removeEnvVar"
            | "openEnvFile"
            | "sendTerminalInput"
            | "updateAgent"
            | "addAgent"
            | "setTeamMode"
    );

    let owner_decision_cmd = matches!(
        cmd,
        "resolveActionItem" | "resolveDecision" | "recordGate" | "sendProposal"
    );

    if matches!(role, ServerRole::Operator) {
        if owner_only_always {
            return CommandVerdict::Denied("requires owner role");
        }
        if local_host_escape && ctx.target_agent_local {
            return CommandVerdict::Denied(
                "operators cannot modify local host agents, env files, or host terminals",
            );
        }
        if owner_decision_cmd && ctx.decision_owner_only {
            return CommandVerdict::Denied("this approval or gate is restricted to the owner");
        }
    }

    let needs_step_up = matches!(
        cmd,
        "sendTerminalInput"
            | "openShell"
            | "openHostShell"
            | "setEnvVar"
            | "removeEnvVar"
            | "openEnvFile"
            | "setSecret"
            | "removeSecret"
            | "saveAccount"
            | "testAccountKey"
            | "removeAccount"
            | "resolveActionItem"
            | "resolveDecision"
            | "recordGate"
            | "sendProposal"
            | "setEgressMode"
            | "allowEgressHost"
            | "updateAgent"
            | "updateRole"
            | "setTeamMode"
            | "deleteProject"
            | "manageUsers"
            | "setProjectRole"
            | "runSetupFix"
            | "recreateSandbox"
            | "addMcp"
            | "removeMcp"
    );

    if ctx.remote && needs_step_up && !ctx.elevated {
        return CommandVerdict::StepUpRequired;
    }

    CommandVerdict::Allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(role: ServerRole) -> AuthContext {
        AuthContext { server_role: role, project_role: None, remote: false, elevated: false, target_agent_local: false, decision_owner_only: false }
    }

    #[test]
    fn operator_is_allow_listed_and_unknown_commands_are_owner_only() {
        let op = ctx(ServerRole::Operator);
        assert_eq!(authorize_command("startAgent", &op), CommandVerdict::Allowed);
        for cmd in ["removeAgent", "updateWorkflow", "saveConnection", "updateSandbox", "brandNewCommand"] {
            assert!(matches!(authorize_command(cmd, &op), CommandVerdict::Denied(_)), "{cmd}");
            assert_eq!(authorize_command(cmd, &ctx(ServerRole::Owner)), CommandVerdict::Allowed, "{cmd}");
        }
    }

    #[test]
    fn mcp_live_checks_need_an_operator_and_adding_needs_the_owner() {
        assert!(matches!(authorize_command("refreshMcp", &ctx(ServerRole::Viewer)), CommandVerdict::Denied(_)));
        assert_eq!(authorize_command("refreshMcp", &ctx(ServerRole::Operator)), CommandVerdict::Allowed);
        assert!(matches!(authorize_command("addMcp", &ctx(ServerRole::Operator)), CommandVerdict::Denied(_)));
        assert_eq!(authorize_command("addMcp", &ctx(ServerRole::Owner)), CommandVerdict::Allowed);
    }

    #[test]
    fn only_the_owner_changes_agent_egress() {
        for cmd in ["setEgressMode", "allowEgressHost", "ignoreEgressHost", "removeEgressRule"] {
            for role in [ServerRole::Operator, ServerRole::Viewer] {
                assert!(matches!(authorize_command(cmd, &ctx(role)), CommandVerdict::Denied(_)), "{cmd}");
            }
            assert_eq!(authorize_command(cmd, &ctx(ServerRole::Owner)), CommandVerdict::Allowed, "{cmd}");
        }
        let remote = AuthContext { remote: true, ..ctx(ServerRole::Owner) };
        assert_eq!(authorize_command("setEgressMode", &remote), CommandVerdict::StepUpRequired);
    }
}
