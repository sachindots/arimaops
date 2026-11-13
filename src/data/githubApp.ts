// SPDX-License-Identifier: AGPL-3.0-or-later
// The GitHub App HQ asks GitHub to create (docs/agent-engine.md section 6): read-only access to pull requests,
// checks, statuses and contents, and the webhook events that can change a PR. Shared: the browser posts this
// manifest to GitHub; the server accepts exactly these events.

/** sessionStorage key for the manifest form's `state`, matched when GitHub sends the browser back. */
export const GITHUB_STATE_KEY = "arima-github-app-state";

export const WEBHOOK_PATH = "/api/github/webhook";
export const WEBHOOK_EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_suite", "check_run", "status", "push"];

/** `hookUrl`: the public (Funnel) webhook address. `redirectUrl`: where GitHub sends the browser back with a one-time code. */
export function appManifest(name: string, hookUrl: string, redirectUrl: string) {
  return {
    name: name.slice(0, 34),
    url: "https://github.com/sachindots/arimaops",
    hook_attributes: { url: hookUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: { pull_requests: "read", checks: "read", contents: "read", statuses: "read", metadata: "read" },
    default_events: WEBHOOK_EVENTS,
  };
}

/** GitHub's "new App" form for a personal account, or for an organization when `org` is set. */
export const newAppUrl = (state: string, org = "") =>
  `${org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : "https://github.com/settings/apps/new"}?state=${encodeURIComponent(state)}`;
