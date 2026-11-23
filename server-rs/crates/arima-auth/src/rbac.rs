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
            "recheckSetup" | "refreshSbx" | "refreshMcp" | "ping" => CommandVerdict::Allowed,
            _ => CommandVerdict::Denied("viewer role is strictly read-only"),
        };
    }

    let owner_only_always = matches!(
        cmd,
        "openHostShell"
            | "openShell"
            | "saveAccount"
            | "testAccountKey"
            | "removeAccount"
            | "setProxy"
            | "addMcp"
            | "runSetupFix"
            | "deleteProject"
            | "importTemplate"
            | "promoteLessons"
            | "setLessonPromotion"
            | "removeLesson"
            | "setMemoryExtraction"
            | "addToSuite"
            | "manageUsers"
            | "setProjectRole"
    );

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
            | "setProxy"
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
