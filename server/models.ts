// Native API catalogs, fetched server-side: account keys never reach the model picker.
import { z } from "zod";
import type { AgentCli } from "../src/data/types";
import { clisFor, type Provider } from "../src/data/providers";
import { accounts } from "./credentials/registry";

const list = z.object({ data: z.array(z.object({ id: z.string() })) });
const googleList = z.object({ models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })) });
export function modelIds(provider: Provider, body: unknown): string[] {
  if (provider === "google") return googleList.parse(body).models.filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
  return list.parse(body).data.map((m) => m.id).filter((id) => provider !== "openai" || /^(gpt-|o\d|codex)/.test(id));
}
const cache = new Map<string, { until: number; ids: string[] }>();
export async function accountModels(id: string, cli: AgentCli, fetcher = fetch): Promise<string[]> {
  const a = accounts().get(id);
  if (!a || !clisFor(a.provider).includes(cli)) throw new Error("This account cannot be used with the selected CLI.");
  const view = accounts().views().find((v) => v.id === id);
  const cacheKey = `${id}:${a.provider}:${view?.secret?.updatedAt}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.ids;
  const key = accounts().keyFor(id, a.provider);
  if (!key) throw new Error("This account has no saved key.");
  const headers: Record<string, string> = {};
  let url: string;
  switch (a.provider) {
    case "anthropic": url = "https://api.anthropic.com/v1/models"; headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; break;
    case "openai": url = "https://api.openai.com/v1/models"; headers.Authorization = `Bearer ${key}`; break;
    case "google": url = "https://generativelanguage.googleapis.com/v1beta/models"; headers["x-goog-api-key"] = key; break;
    case "openrouter": url = "https://openrouter.ai/api/v1/models"; headers.Authorization = `Bearer ${key}`; break;
    case "deepseek": url = "https://api.deepseek.com/models"; headers.Authorization = `Bearer ${key}`; break;
    case "bedrock": case "vertex": throw new Error("Use a custom model ID from this cloud account's regional catalog.");
  }
  const ids: string[] = [];
  let page = url;
  for (let n = 0; page; n++) {
    if (n >= 20) throw new Error("The provider catalog is too large to load completely. Try again later.");
    const r = await fetcher(page, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`The provider model catalog returned HTTP ${r.status}. Check the account key and access.`);
    const body: unknown = await r.json();
    ids.push(...modelIds(a.provider, body));
    const paging = z.object({ nextPageToken: z.string().optional(), has_more: z.boolean().optional(), last_id: z.string().optional() }).parse(body);
    page = "";
    if (a.provider === "google" && paging.nextPageToken) page = `${url}?pageToken=${encodeURIComponent(paging.nextPageToken)}`;
    if (a.provider === "anthropic" && paging.has_more) {
      if (!paging.last_id) throw new Error("The provider returned an incomplete catalog page.");
      page = `${url}?after_id=${encodeURIComponent(paging.last_id)}`;
    }
  }
  if (!ids.length) throw new Error("No compatible models were returned for this account.");
  cache.set(cacheKey, { until: Date.now() + 60_000, ids });
  return ids;
}

export async function checkAccountModel(account: string, cli: AgentCli, model: string) {
  const a = accounts().get(account);
  if (!a) return;
  if (!clisFor(a.provider).includes(cli)) throw new Error("This account cannot be used with the selected CLI.");
  const m = model.trim();
  if (!m || /^default$/i.test(m)) return;
  if ((a.provider === "openai" && /^(claude|gemini|anthropic\/)/i.test(m)) ||
      (a.provider === "anthropic" && /^(gpt-|o\d|gemini|openai\/)/i.test(m)) ||
      (a.provider === "google" && /^(claude|gpt-|o\d|anthropic\/|openai\/)/i.test(m)))
    throw new Error("The model belongs to another provider. Select a model from this account's catalog.");
  if (a.provider === "bedrock" || a.provider === "vertex") return; // Regional IAM catalogs need the cloud SDK; preserve explicit custom IDs.
  if (a.provider === "anthropic" && /^(opus|sonnet|haiku|fable)$/i.test(m)) return;
  if (!(await accountModels(account, cli)).includes(m)) throw new Error(`Model ${m} is not in this account's catalog. Select an available model or CLI Default.`);
}
