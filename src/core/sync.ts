// Turn-sync is continuous repository intelligence for the active agent loop.
// Before agent start and after each assistant turn it compares extracted facts
// against its baseline, regardless of whether edits came from Pi tools,
// fabric_exec, bash, a subagent, or an external editor. Content hashes provide
// the cheap unchanged path; semantic fingerprints ignore coordinate-only drift.
//
// A route change or enough newly relevant files emits compact causal context.
// Pre-agent drift is injected directly; post-turn drift is sent as a steer and
// triggers a continuation if the agent would otherwise become idle.
//
// The first sync establishes the baseline. Baselines reset on /new, /fork,
// and /fovea reset alongside focus sessions.

import { ROOT_CACHE_LIMIT, forEachChunked } from "./asyncutil.js";
import { ensureState, ensureStateBackground, focus, getInflight, getState, impact, isTestScope } from "./ops.js";
import type { RepoState } from "./ops.js";
import { getSession } from "./session.js";

interface SyncBaseline {
  version: string;
  anchors: Set<string>;
  /** file -> content sha1 at baseline; used only for fast drift detection. */
  shas: Map<string, string>;
  /** file -> extracted semantic facts, excluding the content hash. */
  semantics: Map<string, string>;
  /** Previously reported undisclosed warmth, for delta delivery. */
  warmed?: Set<string>;
  /** Drift targets already push-embedded in this baseline chain (embed-once). */
  pushed?: Set<string>;
}

const baselines = new Map<string, SyncBaseline>();
const getBaseline = (root: string): SyncBaseline | undefined => {
  const hit = baselines.get(root);
  if (hit) {
    baselines.delete(root);
    baselines.set(root, hit);
  }
  return hit;
};
const setBaseline = (root: string, baseline: SyncBaseline): void => {
  baselines.delete(root);
  baselines.set(root, baseline);
  while (baselines.size > ROOT_CACHE_LIMIT) baselines.delete(baselines.keys().next().value!);
};

export const resetSyncBaselines = (): void => {
  baselines.clear();
  warmCache.clear();
};

// Background warm. The blocking `sync` call on the user-perceived send path
// (before_agent_start / turn_end) recomputes extraction, graph assembly, the
// baseline fingerprint, and the impact cascade whenever the repo drifted.
// `warmSync` runs those heavyweight ingredients eagerly as soon as edits land
// (tool_execution_end), keyed by state version + changed-file set, so the same
// drift's sync call reuses them and stays verdict-only. Never advances the
// baseline, never reports, never throws; a drift without a warm (external
// edits between turns) falls back to the inline compute in `sync`.

interface WarmCompute {
  /** State version this computation fingerprints. */
  version: string;
  /** Canonical key of the changed-file set this warm covers. */
  filesKey: string;
  /** Full next-baseline snapshot, identical to snapshot(state). */
  snapshot: SyncBaseline;
  /** impact() outputs for the changed set. */
  warmedFiles: string[];
  warmReasons: Record<string, string[]>;
}

const warmCache = new Map<string, WarmCompute>();

const filesKey = (files: readonly string[]): string => [...new Set(files)].sort().join("\n");

/** Files whose extracted facts moved since a baseline, in canonical order. */
const semanticDrift = (state: RepoState, prev: SyncBaseline): string[] => {
  const changed = Object.keys(state.facts).filter(
    (file) => prev.shas.get(file) !== state.facts[file]!.sha1,
  );
  return changed.filter(
    (file) => prev.semantics.get(file) !== semanticFacts(state, file) && state.graph.byFile.has(file),
  );
};

export interface WarmParams {
  /** Optional drift hints, same role as sync hints; the probe stays the oracle. */
  files?: string[];
  /** Token budget for the impact cascade (mirrors sync.budget). */
  budget: number;
}

export const warmSync = async (root: string, params: WarmParams, state?: RepoState): Promise<void> => {
  try {
    const cur = state ?? (await ensureState(root, { hints: params.files ?? [], force: false }));
    const prev = getBaseline(root);
    if (!prev || prev.version === cur.version) return;
    const files = semanticDrift(cur, prev);
    if (!files.length) return;
    const key = filesKey(files);
    const cached = warmCache.get(root);
    if (cached && cached.version === cur.version && cached.filesKey === key) return;
    const next = await snapshot(cur);
    // The impact cascade runs against the same immutable state snapshot the
    // fingerprint used, so the cached pair is consistent for cur.version.
    const result = await impact(root, { files, includeUncommitted: false, budget: params.budget }, cur);
    warmCache.set(root, {
      version: cur.version,
      filesKey: key,
      snapshot: next,
      warmedFiles: (result.details.warmedFiles as string[] | undefined) ?? [],
      warmReasons: (result.details.warmedReasons as Record<string, string[]> | undefined) ?? {},
    });
    while (warmCache.size > ROOT_CACHE_LIMIT) warmCache.delete(warmCache.keys().next().value!);
  } catch {
    // Best-effort: a failed warm just means the next blocking sync computes
    // inline (with its own error reporting), exactly as before.
  }
};

export interface SyncParams {
  /** Optional drift hints (e.g. files touched by pi's edit/write tools this
   * turn). Unioned into the warmth seeds; never the source of truth. */
  files?: string[];
  budget: number;
  warmFileThreshold: number;
  /** Push vs pull (default push): embed the top file target's focus context. */
  pushFocus?: boolean;
}

export interface SyncOutcome {
  /** The graph version drifted since the last sync. */
  structural: boolean;
  /** Issues worth spending model tokens on. */
  red: boolean;
  text?: string;
  tokens: number;
  details: Record<string, unknown>;
}

type SemanticFact = RepoState["facts"][string];
const semanticCache = new WeakMap<SemanticFact, string>();

const semanticFacts = (state: RepoState, file: string): string => {
  const facts = state.facts[file];
  if (!facts) return "";
  const cached = semanticCache.get(facts);
  if (cached !== undefined) return cached;
  const stable = (rows: unknown[][]): string[] => rows.map((row) => JSON.stringify(row)).sort();
  const compactSig = (sig: string): string => sig.replace(/\s+/g, " ").trim();
  const value = JSON.stringify({
    symbols: stable(facts.symbols.map((symbol) => [symbol.name, symbol.kind, compactSig(symbol.sig), symbol.lang])),
    imports: stable(facts.imports.map((site) => [site.spec])),
    calls: stable(facts.calls.map((site) => [site.callee])),
    literals: stable(facts.literals.map((site) => [site.text])),
    anchors: stable(facts.anchors.map((anchor) => [anchor.id, anchor.kind, anchor.nodeId, anchor.implicit === true])),
    sigs: Object.entries(facts.sigs ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
  semanticCache.set(facts, value);
  return value;
};

const snapshot = async (state: RepoState): Promise<SyncBaseline> => {
  const anchors = new Set<string>();
  await forEachChunked(state.graph.anchors, 256, (anchor) => anchors.add(anchor.id));
  const shas = new Map<string, string>();
  const semantics = new Map<string, string>();
  await forEachChunked(Object.entries(state.facts), 256, ([file, facts]) => {
    shas.set(file, facts.sha1);
    semantics.set(file, semanticFacts(state, file));
  });
  return { version: state.version, anchors, shas, semantics };
};

export const sync = async (
  root: string,
  params: SyncParams,
  now?: RepoState,
  opts?: { probe?: "cheap" | "full" },
): Promise<SyncOutcome> => {
  let state = now;
  if (!state) {
    // Cold roots build in the background; a first answer beats a full build.
    // Hooks live on the TUI thread — the "indexing" outcome is how callers
    // learn to stay quiet this turn and let the background build land.
    const warm = getState(root);
    if (!warm) {
      if (!getInflight(root)) ensureStateBackground(root);
      return { structural: false, red: false, tokens: 0, details: { indexing: true } };
    }
    state = await ensureState(root, { hints: params.files, force: opts?.probe !== "cheap" });
  }
  const prev = getBaseline(root);
  if (prev && prev.version === state.version) {
    return { structural: false, red: false, tokens: 0, details: { version: state.version } };
  }
  if (!prev) {
    setBaseline(root, await snapshot(state));
    return {
      structural: true, red: false, tokens: 0,
      details: { version: state.version, baseline: "established", anchors: state.graph.anchors.length },
    };
  }

  // Version drifted: measure what moved. Implicit (tier-3 discovered) hubs
  // churn is reported but NEVER escalates alone — hypotheses with no first-class
  // backing don't get to wake the model with a red verdict.
  const current = new Map(state.graph.anchors.map((a) => [a.id, a.implicit === true]));
  const currentIds = new Set(current.keys());
  const added = [...currentIds].filter((id) => !prev.anchors.has(id));
  const removed = [...prev.anchors].filter((id) => !currentIds.has(id));
  const newlyImplicit = added.filter((id) => current.get(id));

  const session = getSession(root);
  const disclosedFiles = new Set<string>();
  for (const id of session.disclosed) {
    const at = id.indexOf("@");
    if (at >= 0) disclosedFiles.add(id.slice(at + 1));
  }

  // Exact change set: facts whose content hash moved since the baseline.
  // Deleted files can't warm anything (absent from the graph) but ride along
  // in details for observability.
  const changed = Object.keys(state.facts).filter(
    (file) => prev.shas.get(file) !== state.facts[file]!.sha1,
  );
  const semanticChanged = semanticDrift(state, prev);
  const hinted = (params.files ?? []).filter((file) => semanticChanged.includes(file));
  const deleted = [...prev.shas.keys()].filter((file) => !(file in state.facts));
  const files = [...new Set([...semanticChanged, ...hinted])];

  let warmNow: Set<string> = new Set();
  let warmNew: string[] = [];
  let warmReasons: Record<string, string[]> = {};
  let preparedBaseline: SyncBaseline | undefined;
  if (files.length) {
    // Edit-time `warmSync` may have precomputed the heavyweight ingredients —
    // the next baseline fingerprint and the impact cascade — so this blocking
    // hook only renders the verdict. Keyed by state version + changed set, a
    // stale warm (more drift landed since) falls through to the inline compute.
    const prepared = warmCache.get(root);
    const preparedHit =
      prepared !== undefined &&
      prepared.version === state.version &&
      prepared.filesKey === filesKey(files);
    if (preparedHit) {
      warmCache.delete(root);
      preparedBaseline = prepared.snapshot;
      warmReasons = prepared.warmReasons;
      warmNow = new Set(prepared.warmedFiles.filter(
        (file) => !disclosedFiles.has(file) && !files.includes(file),
      ));
    } else {
      const result = await impact(root, { files, includeUncommitted: false, budget: params.budget });
      const warmedFiles = (result.details.warmedFiles as string[] | undefined) ?? [];
      warmReasons = (result.details.warmedReasons as Record<string, string[]> | undefined) ?? {};
      warmNow = new Set(warmedFiles.filter((file) => !disclosedFiles.has(file) && !files.includes(file)));
    }
    warmNew = prev.warmed === undefined
      ? [...warmNow]
      : [...warmNow].filter((file) => !prev.warmed!.has(file));
  }

  const pushed = new Set(prev.pushed ?? []);
  setBaseline(root, { ...(preparedBaseline ?? (await snapshot(state))), warmed: warmNow, pushed });

  // Extraction failures leave fact gaps that look like anchor *removals* —
  // never escalate red on removals while degraded; the degraded note is
  // already loud in details.
  const degraded = state.extraction.failed.length > 0;
  const red = (added.length - newlyImplicit.length) > 0 ||
    (removed.length > 0 && !degraded) ||
    deleted.some((file) => !isTestScope(file)) ||
    warmNew.length >= Math.max(1, params.warmFileThreshold);
  if (!red) {
    return {
      structural: true, red: false, tokens: 0,
      details: {
        version: state.version,
        anchorsDelta: added.length - removed.length,
        warmNew: warmNew.length,
        changedFiles: changed,
        semanticChangedFiles: files,
        deletedFiles: deleted,
        ...(degraded ? { extractionDegraded: true } : {}),
      },
    };
  }

  const changedSummary = files.length
    ? `${files.slice(0, 4).join(", ")}${files.length > 4 ? ` (+${files.length - 4} more)` : ""}`
    : deleted.length
      ? `deleted ${deleted.slice(0, 4).join(", ")}${deleted.length > 4 ? ` (+${deleted.length - 4} more)` : ""}`
      : "route structure";
  const orderedWarm = [...warmNew].sort((a, b) =>
    Number(isTestScope(a)) - Number(isTestScope(b)) || a.localeCompare(b));
  const lines: string[] = [
    "Repository structure changed.",
    `Changed: ${changedSummary}`,
  ];
  for (const id of added.filter((anchor) => !newlyImplicit.includes(anchor)).slice(0, 6)) {
    lines.push(`Route added: ${id}`);
  }
  // Degraded removals are suspect (extraction gaps look like removals); the
  // escalation gate already distrusts them, so the message does too.
  if (!degraded) for (const id of removed.slice(0, 6)) lines.push(`Route removed: ${id}`);
  if (orderedWarm.length) {
    lines.push("Newly relevant files:");
    for (const file of orderedWarm.slice(0, 8)) {
      lines.push(`  ${file} — ${(warmReasons[file] ?? ["graph path"]).join(", ")}`);
    }
  }
  // Push vs pull on the consequence probe. A file target gets its refreshed
  // focus context embedded inline (the embed discloses it, so any follow-up
  // probe is a session delta and nearly free); each target embeds at most
  // once per baseline chain. Route targets keep the advisory pending route
  // fuzzy-match quality, and the no-target case stays verdict-only. Pull
  // mode renders the advisory unconditionally.
  const focusTarget = added.find((id) => !newlyImplicit.includes(id))?.replace(/^\w+\s+(?=\/)/, "")
    ?? files[0]
    ?? orderedWarm[0];
  const pushFocus = params.pushFocus !== false;
  const steerLine = "Steer: account for this update before continuing.";
  let embedded = false;
  if (pushFocus && focusTarget && focusTarget in state.facts && !pushed.has(focusTarget)) {
    const detailBudget = params.budget - Math.ceil([...lines, steerLine].join("\n").length / 4);
    if (detailBudget >= 128) {
      try {
        const detail = await focus(root, focusTarget, detailBudget);
        if (detail.text.trim()) {
          lines.push(...detail.text.split("\n"));
          pushed.add(focusTarget);
          embedded = true;
        }
      } catch {
        // Focus is best-effort context; fall through to the advisory.
      }
    }
  }
  if (!embedded && (!pushFocus || focusTarget)) {
    lines.push(focusTarget
      ? `Next: fovea_focus ${JSON.stringify(focusTarget)} to see what it now connects to.`
      : "Next: fovea_sketch for the updated silhouette.");
  }
  lines.push(steerLine);
  while (lines.length > 3 && Math.ceil(lines.join("\n").length / 4) > params.budget) {
    lines.splice(lines.length - 2, 1);
  }
  const text = lines.join("\n");
  return {
    structural: true, red: true, text, tokens: Math.ceil(text.length / 4),
    details: {
      version: state.version,
      added,
      removed,
      changedFiles: changed,
      semanticChangedFiles: files,
      warmNew: orderedWarm,
      warmReasons,
      deletedFiles: deleted,
      ...(embedded ? { pushedFocus: focusTarget } : {}),
      ...(degraded ? { extractionDegraded: true } : {}),
    },
  };
};
