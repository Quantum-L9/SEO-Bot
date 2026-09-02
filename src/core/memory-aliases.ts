/* L9_META
 * layer: module
 * role: governed_memory_aliases
 * status: active
 * version: 1.0.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_L9_MEMORY_MODE = "required";
export const DEFAULT_L9_MEMORY_URL = "http://127.0.0.1:8100";

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function parseGraphitiMachineAliases(contents: string): {
  GRAPHITI_MCP_TOKEN?: string;
  GRAPHITI_MCP_URL?: string;
} {
  const out: { GRAPHITI_MCP_TOKEN?: string; GRAPHITI_MCP_URL?: string } = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "GRAPHITI_MCP_TOKEN" && key !== "GRAPHITI_MCP_URL") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

export function applyGraphitiMachineAliases(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME ?? env.USERPROFILE,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  if (!isBlank(env.GRAPHITI_MCP_TOKEN) && !isBlank(env.GRAPHITI_MCP_URL)) return;
  if (!homeDir) return;
  try {
    const parsed = parseGraphitiMachineAliases(readFile(join(homeDir, ".cursor", "graphiti.env")));
    if (isBlank(env.GRAPHITI_MCP_TOKEN) && parsed.GRAPHITI_MCP_TOKEN) {
      env.GRAPHITI_MCP_TOKEN = parsed.GRAPHITI_MCP_TOKEN;
    }
    if (isBlank(env.GRAPHITI_MCP_URL) && parsed.GRAPHITI_MCP_URL) {
      env.GRAPHITI_MCP_URL = parsed.GRAPHITI_MCP_URL;
    }
  } catch {
    // Host overlay is optional inside containers; compose / Infisical supply the token.
  }
}

/** Memory is required. Blank L9_MEMORY_* rows alias Graphiti machine credentials. */
export function applyMemoryAliases(env: NodeJS.ProcessEnv = process.env): void {
  applyGraphitiMachineAliases(env);
  if (isBlank(env.L9_MEMORY_MODE)) env.L9_MEMORY_MODE = DEFAULT_L9_MEMORY_MODE;
  if (isBlank(env.L9_MEMORY_TOKEN) && !isBlank(env.GRAPHITI_MCP_TOKEN)) {
    env.L9_MEMORY_TOKEN = env.GRAPHITI_MCP_TOKEN;
  }
  if (isBlank(env.L9_MEMORY_URL) && !isBlank(env.GRAPHITI_MCP_URL)) {
    env.L9_MEMORY_URL = env.GRAPHITI_MCP_URL;
  }
  if (isBlank(env.L9_MEMORY_URL)) env.L9_MEMORY_URL = DEFAULT_L9_MEMORY_URL;
}
