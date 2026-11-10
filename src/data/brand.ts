// Centralized brand & path constants for ArimaOps (அரிமா, Tamil for lion), a fork of JSM HQ / .hq.
// Paths, CLI names and storage prefixes still carry the .hq / dothq names so running agents are not disturbed.

export const BRAND = {
  /** Primary display name in UI headers and prose. */
  name: "ArimaOps",
  /** Long-form name for titles and descriptions. */
  fullName: "ArimaOps · அரிமா",
  /** Default pixel sign on the operations center wall (fits up to 19 chars). */
  officeSign: "ARIMAOPS",
  /** CLI binary command name. */
  bin: "dothq",
  /** Legacy CLI binary alias kept for compatibility. */
  legacyBin: "jsm-hq",
  /** Per-repo configuration folder (.hq/config.json, .hq/plan.json). */
  repoDir: ".hq",
  /** Legacy per-repo configuration folder (.jsmhq/). */
  legacyRepoDir: ".jsmhq",
  /** Machine-wide per-project state folder (~/.hq/<project>/). */
  homeDir: ".hq",
  /** Legacy machine-wide state folder (~/.jsmhq/<project>/). */
  legacyHomeDir: ".jsmhq",
  /** Agent workspace role file (git-excluded). */
  roleFile: ".hq-role.md",
  /** Legacy agent workspace role file. */
  legacyRoleFile: ".jsmhq-role.md",
  /** Local-mode Windows node hook script (git-excluded). */
  hookScript: ".hq-hook.mjs",
  /** Legacy node hook script. */
  legacyHookScript: ".jsmhq-hook.mjs",
  /** Shell comment marker identifying HQ-managed hooks. */
  hookMark: "# dothq-hook",
  legacyHookMark: "# jsmhq-hook",
  /** CLI arg marker identifying HQ-managed node hooks. */
  hookMarkArg: "--dothq-hook",
  legacyHookMarkArg: "--jsmhq-hook",
  /** Header written into .git/info/exclude. */
  excludeHeader: "# .hq",
  /** Browser localStorage key prefix. */
  storagePrefix: "dothq",
  legacyStoragePrefix: "jsmhq",
} as const;
