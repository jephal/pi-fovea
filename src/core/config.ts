// pi-fovea configuration. Mirrors pi-fabric's two-scope model: a global file
// under the pi agent dir (~/.pi/agent/fovea.json) and a project override at
// <repo>/.pi/fovea.json when the project is trusted. Settings merge over
// defaults; the FOVEA_TURN_SYNC=off environment variable always wins, the
// same way PI_FABRIC_* overrides win over stored fabric config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface FoveaSyncConfig {
  /** turn_end feedback loop on/off (the default-on, opt-out knob). */
  enabled: boolean;
  /** Token budget for proactive model steering context. */
  budget: number;
  /** Also send a tiny model-visible ack on clean turns (default false: silent green). */
  ackClean: boolean;
  /** Number of newly relevant files that justifies proactive steering on its own. */
  warmFileThreshold: number;
}

interface FoveaToolsConfig {
  /** Budget applied when a fovea_* tool call omits maxTokens. */
  defaultBudget: number;
  /** Install hybrid grep: native text semantics plus bare-query Fovea navigation. */
  replaceGrep: boolean;
}

export interface FoveaConfig {
  sync: FoveaSyncConfig;
  tools: FoveaToolsConfig;
}

export const DEFAULT_FOVEA_CONFIG: FoveaConfig = {
  sync: {
    enabled: true,
    budget: 1024,
    ackClean: false,
    warmFileThreshold: 2,
  },
  tools: {
    defaultBudget: 2000,
    replaceGrep: true,
  },
};

export interface FoveaConfigScopes {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}

export const globalFoveaConfigPath = (agentDir: string): string => path.join(agentDir, "fovea.json");
export const projectFoveaConfigPath = (cwd: string): string => path.join(cwd, ".pi", "fovea.json");

const BOUNDS: Record<string, [number, number]> = {
  "sync.budget": [128, 8192],
  "tools.defaultBudget": [256, 16000],
  "sync.warmFileThreshold": [1, 16],
};

const clamp = (id: string, value: number): number => {
  const [lo, hi] = BOUNDS[id] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return Math.min(hi, Math.max(lo, Math.round(value)));
};

const boolValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const intValue = (id: string, value: unknown, fallback: number): number =>
  clamp(id, typeof value === "number" && Number.isFinite(value) ? value : fallback);

const applyPartial = (base: FoveaConfig, partial: unknown): FoveaConfig => {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) return base;
  const src = partial as Record<string, unknown>;
  const sync = (typeof src.sync === "object" && src.sync !== null ? src.sync : {}) as Record<string, unknown>;
  const tools = (typeof src.tools === "object" && src.tools !== null ? src.tools : {}) as Record<string, unknown>;
  return {
    sync: {
      enabled: boolValue(sync.enabled, base.sync.enabled),
      budget: intValue("sync.budget", sync.budget, base.sync.budget),
      ackClean: boolValue(sync.ackClean, base.sync.ackClean),
      warmFileThreshold: intValue("sync.warmFileThreshold", sync.warmFileThreshold, base.sync.warmFileThreshold),
    },
    tools: {
      defaultBudget: intValue("tools.defaultBudget", tools.defaultBudget, base.tools.defaultBudget),
      replaceGrep: boolValue(tools.replaceGrep, base.tools.replaceGrep),
    },
  };
};

const readConfigFile = (file: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const loadFoveaConfig = (scopes: FoveaConfigScopes): FoveaConfig => {
  let config = applyPartial(DEFAULT_FOVEA_CONFIG, readConfigFile(globalFoveaConfigPath(scopes.agentDir)));
  if (scopes.projectTrusted) {
    config = applyPartial(config, readConfigFile(projectFoveaConfigPath(scopes.cwd)));
  }
  // Environment override mirrors pi-fabric's PI_* precedence over stored values.
  const off = process.env.FOVEA_TURN_SYNC;
  if (off === "off" || off === "0" || off === "false") config = { ...config, sync: { ...config.sync, enabled: false } };
  return config;
};

const mergeDeep = (existing: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...existing };
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)
        && typeof out[key] === "object" && out[key] !== null) {
      out[key] = mergeDeep(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const saveFoveaConfig = (
  scopes: FoveaConfigScopes,
  partial: Record<string, unknown>,
): { scope: "global" | "project"; path: string } => {
  const targetPath = scopes.projectTrusted
    ? projectFoveaConfigPath(scopes.cwd)
    : globalFoveaConfigPath(scopes.agentDir);
  const merged = mergeDeep(readConfigFile(targetPath), partial);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  fs.renameSync(tmp, targetPath);
  return { scope: scopes.projectTrusted ? "project" : "global", path: targetPath };
};

export const defaultAgentDir = (): string => path.join(os.homedir(), ".pi", "agent");

/** Dotted-id helper used by the settings UI -> saveFoveaConfig partials. */
export const buildPartialFromId = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    current[segments[i]!] = next;
    current = next;
  }
  current[segments[segments.length - 1]!] = value;
  return root;
};
