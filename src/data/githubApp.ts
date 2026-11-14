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

/** Anthropic's security review on every PR, pinned like the skill packs (skill-packs.lock.json). Offered, never installed by HQ. */
export const SECURITY_REVIEW_ACTION = { source: "anthropics/claude-code-security-review", commit: "0c6a49f1fa56a1d472575da86a94dbc1edb78eda" };
const CHECKOUT_V4 = "11d5960a326750d5838078e36cf38b85af677262";

/** The workflow file the owner adds to the repo (.github/workflows/security-review.yml). Needs a CLAUDE_API_KEY repo secret. */
export const securityReviewWorkflow = () => `# Security review of every pull request (Anthropic's claude-code-security-review), pinned by commit.
# Add a repository secret CLAUDE_API_KEY (an Anthropic API key) first. Each run uses that key.
name: Security review

permissions:
  pull-requests: write # comments on the PR
  contents: read

on:
  pull_request:

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_V4} # v4
        with:
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
          fetch-depth: 2
      - uses: ${SECURITY_REVIEW_ACTION.source}@${SECURITY_REVIEW_ACTION.commit}
        with:
          comment-pr: true
          claude-api-key: \${{ secrets.CLAUDE_API_KEY }}
`;
