// Optional HQ judgements only. Never falls back to a paid model or a CLI subscription.
import { z } from "zod";
import { accounts } from "../credentials/registry";

export interface FreeHelperConfig { account: string; model: string }
const catalogSchema = z.object({ data: z.array(z.unknown()) });
const modelSchema = z.object({
  id: z.string(), name: z.string(), pricing: z.record(z.string(), z.unknown()),
  architecture: z.object({ input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).optional(),
});
export function freeModels(body: unknown) {
  return catalogSchema.parse(body).data.flatMap((raw) => {
    const parsed = modelSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  }).filter((m) =>
    m.id.endsWith(":free") && m.pricing.prompt === "0" && m.pricing.completion === "0" &&
    Object.values(m.pricing).every((p) => typeof p === "string" && p.trim() !== "" && Number(p) === 0) &&
    m.architecture?.output_modalities?.includes("text"),
  ).map(({ id, name }) => ({ id, name }));
}
let catalog: { until: number; models: ReturnType<typeof freeModels> } | null = null;
export async function freeModelCatalog(fetcher = fetch) {
  if (catalog && catalog.until > Date.now()) return catalog.models;
  const r = await fetcher("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!r.ok) throw new Error("OpenRouter's free-model catalog is unavailable.");
  const models = freeModels(await r.json());
  catalog = { until: Date.now() + 60_000, models };
  return models;
}
const answerSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) });
let inFlight = 0;
const recent: number[] = [];

export async function askFreeHelper<T>(config: FreeHelperConfig | null | undefined, prompt: string, parse: (value: unknown) => T, fetcher = fetch): Promise<{ json: T } | null> {
  if (!config?.account || !config.model || prompt.length > 12_000) return null;
  // Bound background traffic across all projects; failure uses deterministic rules, never retries.
  while (recent.length && Date.now() - recent[0] > 86_400_000) recent.shift();
  if (inFlight >= 1 || recent.length >= 20) return null;
  inFlight++;
  try {
    if (!(await freeModelCatalog(fetcher)).some((m) => m.id === config.model)) return null;
    const account = accounts().get(config.account);
    if (account?.provider !== "openrouter") return null;
    const key = accounts().keyFor(config.account, "openrouter");
    if (!key) return null;
    recent.push(Date.now());
    const r = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], max_tokens: 512,
        provider: { max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false }, }),
    });
    if (!r.ok) return null;
    const content = answerSchema.parse(await r.json()).choices[0]?.message.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return { json: parse(JSON.parse(content.slice(start, end + 1))) };
  } catch { return null; }
  finally { inFlight--; }
}
