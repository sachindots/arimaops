// What every agent on this machine knows about the company (product, customers, voice, do and don't), and each
// project's team charter. Both go into the agents' role files (server/agentFiles.ts), so they apply at each start.

import { join } from "node:path";
import { readDoc, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";

export const COMPANY_MAX = 3000; // about 750 tokens in every agent's context
export const CHARTER_MAX = 1500;

const file = () => join(homeRoot(), "company.json");

export const companyText = (): string => readDoc<{ text?: string }>(file())?.text ?? "";

export function saveCompany(text: string): string {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, COMPANY_MAX);
  writeDoc(file(), { text: clean });
  return clean;
}
