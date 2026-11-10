// Product name, paths and markers in one place. Older names are kept only so an
// existing install migrates (they're never shown): ".hq" / "dothq" were this
// project's own earlier names; ".jsmhq" is the folder name of the upstream it
// was forked from (JSM HQ), recognised so old installs move over.

export const BRAND = {
  /** Display name in headers and prose. */
  name: "ArimaOps",
  /** Long form for titles. */
  fullName: "ArimaOps · அரிமா",
  /** The lobby sign in the office (fits up to 19 characters). */
  officeSign: "ARIMAOPS",
  /** CLI command. */
  bin: "arimaops",
  /** Per-repo folder (config.json, plan.json, facts.md, skills/). */
  repoDir: ".arima",
  legacyRepoDirs: [".hq", ".jsmhq"],
  /** Machine-wide folder (~/.arima: projects, agents' folders, vault, people, audit log). */
  homeDir: ".arima",
  legacyHomeDirs: [".hq", ".jsmhq"],
  /** Agent workspace role file (git-excluded). */
  roleFile: ".arima-role.md",
  legacyRoleFiles: [".hq-role.md", ".jsmhq-role.md"],
  /** Local-mode Windows hook script (git-excluded). */
  hookScript: ".arima-hook.mjs",
  legacyHookScripts: [".hq-hook.mjs", ".jsmhq-hook.mjs"],
  /** Marks HQ-managed hooks in agents' settings so they can be replaced, never duplicated. */
  hookMark: "# arimaops-hook",
  legacyHookMarks: ["# dothq-hook", "# jsmhq-hook"],
  hookMarkArg: "--arimaops-hook",
  legacyHookMarkArgs: ["--dothq-hook", "--jsmhq-hook"],
  /** Header of HQ's lines in .git/info/exclude. */
  excludeHeader: "# arimaops",
  /** Browser storage key prefix. */
  storagePrefix: "arimaops",
  legacyStoragePrefixes: ["dothq", "jsmhq"],
  /** Where the code lives. */
  repoUrl: "https://github.com/sachindots/arimaops",
} as const;
