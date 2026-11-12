// Vault, accounts, provider table, delivery and redaction. Run: npx tsx scripts/credentials-test.ts
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "arima-cred-"));
process.env.HOME = HOME;
delete process.env.ARIMA_MASTER_KEY;
const { keyFrom, loadMasterKey, Vault } = await import("../server/credentials/vault");
const { Accounts } = await import("../server/credentials/registry");
const { prepareSecrets, removeSecrets, secretsDir } = await import("../server/credentials/deliver");
const { Redactor, secretsOf } = await import("../server/credentials/redact");
const { providerEnv, PROVIDERS, PROVIDER_SPECS, clisFor } = await import("../src/data/providers");
const { shellCommand } = await import("../server/backends/tmux");
const { runArgs } = await import("../server/containers");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e));
  }
};
const mode = (p: string) => statSync(p).mode & 0o777;

// ---------------------------------------------------------------- master key
const noKc = null;
const dir = join(HOME, ".arima");
const m1 = loadMasterKey({ env: "", keychain: noKc, dir });
check("no env, no keychain: a 0600 key file is created", m1.source === "file" && mode(join(dir, "vault.key")) === 0o600);
check("the same key file is reused", loadMasterKey({ env: "", keychain: noKc, dir }).key.equals(m1.key));
check("ARIMA_MASTER_KEY wins over everything", loadMasterKey({ env: "my server secret", keychain: noKc, dir }).source === "env");
let stored: string | null = null;
const fakeKc = { get: () => stored, set: (v: string) => ((stored = v), true) };
const kdir = mkdtempSync(join(tmpdir(), "arima-kc-"));
const mk = loadMasterKey({ env: "", keychain: fakeKc, dir: kdir });
check("with a keychain: the key goes there, not to a file", mk.source === "keychain" && !!stored && !existsSync(join(kdir, "vault.key")));
check("a base64 32-byte key is used as is; other text is hashed", keyFrom(Buffer.alloc(32, 7).toString("base64")).equals(Buffer.alloc(32, 7)) && keyFrom("hello").length === 32);

// ---------------------------------------------------------------- vault
const vfile = join(dir, "vault.json");
const v = new Vault(vfile, m1);
v.set("account:work", "sk-ant-api03-SECRETVALUE-1a2b");
const raw = readFileSync(vfile, "utf8");
check("the vault file never holds the value in clear, and is 0600", !raw.includes("SECRETVALUE") && mode(vfile) === 0o600);
check("values round-trip; the UI list shows only the last 4", v.get("account:work") === "sk-ant-api03-SECRETVALUE-1a2b" && JSON.stringify(v.list()).includes('"last4":"1a2b"') && !JSON.stringify(v.list()).includes("SECRET"));
const tampered = JSON.parse(raw);
tampered.entries["account:other"] = tampered.entries["account:work"]; // moved to another name
writeFileSync(vfile, JSON.stringify(tampered));
check("a value copied to another name doesn't decrypt (name is authenticated)", throws(() => new Vault(vfile, m1).get("account:other"), /auth|Unsupported state/i));
writeFileSync(vfile, raw);
check("a different master key is refused with a clear message", throws(() => new Vault(vfile, { key: keyFrom("wrong"), source: "env" }), /different master key/));

// ---------------------------------------------------------------- accounts
const acc = new Accounts(new Vault(join(dir, "vault2.json"), m1), join(dir, "accounts.json"));
acc.save({ id: "Work Key", provider: "anthropic", secret: "sk-ant-api03-ABCDEFGHIJKLMNOP-9z9z" });
check("names are cleaned; the accounts file holds no secret", acc.get("work-key")?.provider === "anthropic" && !readFileSync(join(dir, "accounts.json"), "utf8").includes("ABCDEFGH"));
check("saving without a key keeps the stored one", (acc.save({ id: "work-key", label: "Team key" }), acc.views()[0].secret?.last4 === "9z9z" && acc.views()[0].label === "Team key"));
check('"default" and empty names are refused', throws(() => acc.save({ id: "default", provider: "openai", secret: "x" }), /not "default"/) && throws(() => acc.save({ id: "", provider: "openai", secret: "x" }), /short name/));
check("a new account needs its key", throws(() => acc.save({ id: "nokey", provider: "openai" }), /Paste/));
let leaked = "";
try {
  acc.save({ id: "bed", provider: "bedrock", secret: "{not json SUPERSECRET" });
} catch (e) {
  leaked = String(e);
}
check("bad cloud JSON is refused without quoting the secret back", /valid JSON/.test(leaked) && !leaked.includes("SUPERSECRET"), leaked);
const env = acc.envFor("work-key", "claude");
check("Claude Code on an Anthropic account gets ANTHROPIC_API_KEY", !!env && !("error" in env) && env.env.ANTHROPIC_API_KEY === "sk-ant-api03-ABCDEFGHIJKLMNOP-9z9z");
const wrong = acc.envFor("work-key", "codex");
check("an account a CLI can't use gives a clear error", !!wrong && "error" in wrong && /can't be used/.test(wrong.error));
check("an unknown account is a subscription (no env)", acc.envFor("personal", "claude") === null);

// ---------------------------------------------------------------- provider table
check("every provider works with at least one CLI", PROVIDERS.every((p) => clisFor(p).length > 0));
const bed = providerEnv("bedrock", "claude", JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-aws-key-value" }), { region: "eu-west-1" });
check("Bedrock: Claude Code gets the Bedrock switch, region and keys", !("error" in bed) && bed.env.CLAUDE_CODE_USE_BEDROCK === "1" && bed.env.AWS_REGION === "eu-west-1" && bed.env.AWS_SECRET_ACCESS_KEY === "s3cr3t-aws-key-value");
const vx = providerEnv("vertex", "gemini", '{"type":"service_account","private_key":"-----BEGIN KEY-----"}', { projectId: "p1", region: "us-central1" });
check("Vertex: the service account goes in a file, referenced by path", !("error" in vx) && vx.files[0]?.name.endsWith(".json") && vx.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith("{file:") && !Object.values(vx.env).some((x) => x.includes("BEGIN KEY")));
check("Codex on OpenAI gets both key variable names", (() => { const o = providerEnv("openai", "codex", "sk-proj-123456789", {}); return !("error" in o) && o.env.OPENAI_API_KEY === o.env.CODEX_API_KEY; })());
check("each provider has a label and a secret hint", PROVIDERS.every((p) => PROVIDER_SPECS[p].label && PROVIDER_SPECS[p].secretHint));

// ---------------------------------------------------------------- delivery
const prep = prepareSecrets("alpha", "nyx", { env: { ANTHROPIC_API_KEY: "sk-ant-DELIVER-me" }, files: [] }, "local", HOME);
check("secrets file is 0600 in a 0700 folder outside the agent's workspace", mode(prep.envFile) === 0o600 && mode(secretsDir("alpha", "nyx", HOME)) === 0o700 && prep.envFile.startsWith(join(HOME, ".arima", "secrets")));
const cmd = shellCommand({ file: "claude", args: [], envFile: null, env: { PORT: "4100" }, secretEnvFile: prep.envFile });
check("the launch command line never contains the key, and deletes the file after loading it", !cmd.includes("DELIVER") && cmd.includes(`rm -f '${prep.envFile}'`) && cmd.indexOf("rm -f") > cmd.indexOf(prep.envFile));
check("subscription agents can't inherit a model key from HQ's own shell", /unset ANTHROPIC_API_KEY [^;]*OPENAI_API_KEY/.test(cmd) && cmd.indexOf("unset ANTHROPIC_API_KEY") < cmd.indexOf(prep.envFile));
const cprep = prepareSecrets("alpha", "lyra", vx as never, "container", HOME);
const args = runArgs({ id: "lyra", cli: "claude", mode: "container", sandbox: { resources: {} } } as never, "hq-alpha-lyra", "/w", [], null, 7420, {}, cprep);
const joined = args.join(" ");
check("container: secrets via --env-file and a read-only mount, never as -e values", joined.includes(`--env-file ${cprep.envFile}`) && joined.includes(":/run/arima/") && joined.includes(":ro") && !joined.includes("BEGIN KEY") && !joined.includes("p1 "));
check("container: the key file path inside is the mounted one", readFileSync(cprep.envFile, "utf8").includes("GOOGLE_APPLICATION_CREDENTIALS=/run/arima/"));
check("a value with a line break is refused (it would inject a second variable)", throws(() => prepareSecrets("a", "b", { env: { X: "a\nEVIL=1" }, files: [] }, "local", HOME), /line break/));
removeSecrets("alpha", "nyx", HOME);
check("stopping an agent removes its secrets folder", !existsSync(secretsDir("alpha", "nyx", HOME)));

// ---------------------------------------------------------------- redaction
const key = "sk-ant-api03-REDACTME-0000-wxyz";
const r = new Redactor(() => [key, JSON.stringify({ accessKeyId: "AKIA1234567", secretAccessKey: "aws-secret-redact-me" })]);
check("whole values and JSON parts are masked", r.redact(`a ${key} b aws-secret-redact-me c`) === "a ••••wxyz b ••••t-me c");
check("short values aren't treated as secrets", secretsOf(["abc"]).length === 0);
const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const serviceAccount = JSON.stringify({
  type: "service_account", project_id: "example-project", private_key_id: "0123456789abcdef0123", private_key: pem,
  client_email: "firebase-adminsdk@example-project.iam.gserviceaccount.com", auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token", universe_domain: "googleapis.com",
});
const r2 = new Redactor(() => [serviceAccount]);
check("a JSON key's secret fields are masked", !r2.redact(`id 0123456789abcdef0123 key ${pem}`).includes("0123456789abcdef0123") && !r2.redact(pem).includes("MIIEvQ"));
const signIn = "https://accounts.google.com/o/oauth2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform";
check("a JSON key's public fields (sign-in addresses, domains) stay readable", r2.redact(signIn) === signIn, r2.redact(signIn));
const out: string[] = [];
r.stream("x", `token: ${key.slice(0, 10)}`, (t) => out.push(t));
r.stream("x", `${key.slice(10)} done`, (t) => out.push(t));
check("a key split across two terminal chunks is still masked", out.join("") === "token: ••••wxyz done" && !out.join("").includes("REDACTME"), JSON.stringify(out));
const out2: string[] = [];
r.stream("y", "plain text ending in sk-", (t) => out2.push(t));
await new Promise((res) => setTimeout(res, 150));
check("a held-back tail is flushed shortly after when no key follows", out2.join("") === "plain text ending in sk-", JSON.stringify(out2));

// ---------------------------------------------------------------- audit log
const { RemoteGuard } = await import("../server/remote");
check("saveAccount and removeAccount need the remote step-up", (await import("../server/remote")).RISKY_COMMANDS.has("saveAccount") && (await import("../server/remote")).RISKY_COMMANDS.has("removeAccount"));
void RemoteGuard;

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
