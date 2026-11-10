// Model providers an agent can use instead of (or besides) a CLI subscription,
// and what each CLI needs to use them. Adding a provider or a CLI pairing is a
// row here; sessions and the UI read this table. Shared by server and UI; the
// UI only uses the metadata, never secret values.

import type { AgentCli } from "./types";

export const PROVIDERS = ["anthropic", "openai", "google", "openrouter", "deepseek", "bedrock", "vertex"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);

/** subscription: the CLI's own sign-in. api-key: one key. cloud: cloud credentials (AWS keys / a GCP service account). */
export type AccountAuth = "subscription" | "api-key" | "cloud";

export interface ProviderField {
  id: string;
  label: string;
  placeholder?: string;
}

/** Files a provider needs on disk (a service-account JSON); `{file:name}` in an env value is replaced by its path. */
export interface ProviderFile {
  name: string;
  content: string;
}

export interface ProviderEnv {
  env: Record<string, string>;
  files: ProviderFile[];
}

interface ProviderSpec {
  label: string;
  auth: Exclude<AccountAuth, "subscription">;
  /** What the secret is, shown on the form. */
  secretLabel: string;
  secretHint: string;
  /** Non-secret settings (region, project). */
  fields: ProviderField[];
  /** Per CLI: the environment that points it at this provider. */
  clis: Partial<Record<AgentCli, (secret: string, fields: Record<string, string>) => ProviderEnv>>;
}

const key = (...names: string[]) => (secret: string): ProviderEnv => ({ env: Object.fromEntries(names.map((n) => [n, secret])), files: [] });

/** AWS access keys as JSON: {"accessKeyId": "...", "secretAccessKey": "...", "sessionToken"?: "..."}. */
function aws(secret: string, region: string): Record<string, string> {
  let k: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
  try {
    k = JSON.parse(secret);
  } catch {
    throw new Error("The AWS credentials aren't valid JSON."); // never the parser's message: it quotes the secret
  }
  if (!k.accessKeyId || !k.secretAccessKey) throw new Error("AWS credentials need accessKeyId and secretAccessKey.");
  return { AWS_REGION: region, AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey, ...(k.sessionToken ? { AWS_SESSION_TOKEN: k.sessionToken } : {}) };
}

const GCP_FILE = "gcp-service-account.json";

export const PROVIDER_SPECS: Record<Provider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic API",
    auth: "api-key",
    secretLabel: "API key",
    secretHint: "sk-ant-… from console.anthropic.com",
    fields: [],
    clis: { claude: key("ANTHROPIC_API_KEY"), opencode: key("ANTHROPIC_API_KEY") },
  },
  openai: {
    label: "OpenAI API",
    auth: "api-key",
    secretLabel: "API key",
    secretHint: "sk-… from platform.openai.com",
    fields: [],
    // shortcut: Codex reads CODEX_API_KEY in newer versions and OPENAI_API_KEY in older ones; both are set until one is confirmed.
    clis: { codex: key("OPENAI_API_KEY", "CODEX_API_KEY"), opencode: key("OPENAI_API_KEY") },
  },
  google: {
    label: "Google AI Studio",
    auth: "api-key",
    secretLabel: "API key",
    secretHint: "From aistudio.google.com",
    fields: [],
    clis: { gemini: key("GEMINI_API_KEY"), opencode: key("GOOGLE_GENERATIVE_AI_API_KEY") },
  },
  openrouter: {
    label: "OpenRouter",
    auth: "api-key",
    secretLabel: "API key",
    secretHint: "sk-or-… from openrouter.ai",
    fields: [],
    clis: { opencode: key("OPENROUTER_API_KEY") },
  },
  deepseek: {
    label: "DeepSeek",
    auth: "api-key",
    secretLabel: "API key",
    secretHint: "From platform.deepseek.com",
    fields: [],
    clis: { opencode: key("DEEPSEEK_API_KEY") },
  },
  bedrock: {
    label: "AWS Bedrock",
    auth: "cloud",
    secretLabel: "AWS access keys (JSON)",
    secretHint: '{"accessKeyId": "AKIA…", "secretAccessKey": "…"}: an IAM user limited to Bedrock',
    fields: [{ id: "region", label: "Region", placeholder: "us-east-1" }],
    clis: {
      claude: (s, f) => ({ env: { CLAUDE_CODE_USE_BEDROCK: "1", ...aws(s, f.region || "us-east-1") }, files: [] }),
      opencode: (s, f) => ({ env: aws(s, f.region || "us-east-1"), files: [] }),
    },
  },
  vertex: {
    label: "Google Vertex AI",
    auth: "cloud",
    secretLabel: "Service account key (JSON)",
    secretHint: "The JSON key of a service account limited to Vertex AI",
    fields: [
      { id: "projectId", label: "Project ID", placeholder: "my-gcp-project" },
      { id: "region", label: "Region", placeholder: "us-east5" },
    ],
    clis: {
      claude: (s, f) => ({
        env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: f.region || "us-east5", ANTHROPIC_VERTEX_PROJECT_ID: f.projectId ?? "", GOOGLE_APPLICATION_CREDENTIALS: `{file:${GCP_FILE}}` },
        files: [{ name: GCP_FILE, content: s }],
      }),
      gemini: (s, f) => ({
        env: { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: f.projectId ?? "", GOOGLE_CLOUD_LOCATION: f.region || "us-central1", GOOGLE_APPLICATION_CREDENTIALS: `{file:${GCP_FILE}}` },
        files: [{ name: GCP_FILE, content: s }],
      }),
    },
  },
};

/** CLIs that can use a provider. */
export const clisFor = (p: Provider): AgentCli[] => Object.keys(PROVIDER_SPECS[p].clis) as AgentCli[];

/** The environment for `cli` on this provider, or an error message when the CLI can't use it. */
export function providerEnv(p: Provider, cli: AgentCli, secret: string, fields: Record<string, string>): ProviderEnv | { error: string } {
  const make = PROVIDER_SPECS[p].clis[cli];
  if (!make) return { error: `${PROVIDER_SPECS[p].label} can't be used with this CLI. It works with: ${clisFor(p).join(", ")}.` };
  try {
    return make(secret, fields);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** What the UI sees of an account: never the secret, only its last 4 characters. */
export interface AccountView {
  id: string;
  provider: Provider;
  auth: AccountAuth;
  label: string;
  fields: Record<string, string>;
  secret: { last4: string; updatedAt: string } | null;
}
