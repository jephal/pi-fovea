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

import { ensureState, impact, isTestScope } from "./ops.js";
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
}

const baselines = new Map<string, SyncBaseline>();

export const resetSyncBaselines = (): void => baselines.clear();

export interface SyncParams {
  /** Optional drift hints (e.g. files touched by pi's edit/write tools this
   * turn). Unioned into the warmth seeds; never the source of truth. */
  files?: string[];
  budget: number;
  warmFileThreshold: number;
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

const semanticFacts = (state: RepoState, file: string): string => {
  const facts = state.facts[file];
  if (!facts) return "";
  const sorted = (rows: unknown[][]): unknown[][] => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const compactSig = (sig: string): string => sig.replace(/\s+/g, " ").trim();
  return JSON.stringify({
    symbols: sorted(facts.symbols.map((symbol) => [symbol.name, symbol.kind, compactSig(symbol.sig), symbol.lang])),
    imports: sorted(facts.imports.map((site) => [site.spec])),
    calls: sorted(facts.calls.map((site) => [site.callee])),
    literals: sorted(facts.literals.map((site) => [site.text])),
    anchors: sorted(facts.anchors.map((anchor) => [anchor.id, anchor.kind, anchor.nodeId, anchor.implicit === true])),
    sigs: Object.entries(facts.sigs ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
};

const snapshot = (state: RepoState): SyncBaseline => ({
  version: state.version,
  anchors: new Set(state.graph.anchors.map((anchor) => anchor.id)),
  shas: new Map(Object.entries(state.facts).map(([file, facts]) => [file, facts.sha1])),
  semantics: new Map(Object.keys(state.facts).map((file) => [file, semanticFacts(state, file)])),
});

export const sync = (root: string, params: SyncParams, now?: RepoState): SyncOutcome => {
  const state = now ?? ensureState(root);
  const prev = baselines.get(root);
  if (prev && prev.version === state.version) {
    return { structural: false, red: false, tokens: 0, details: { version: state.version } };
  }
  if (!prev) {
    baselines.set(root, snapshot(state));
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
  const semanticChanged = changed.filter(
    (file) => prev.semantics.get(file) !== semanticFacts(state, file) && state.graph.byFile.has(file),
  );
  const hinted = (params.files ?? []).filter((file) => semanticChanged.includes(file));
  const deleted = [...prev.shas.keys()].filter((file) => !(file in state.facts));
  const files = [...new Set([...semanticChanged, ...hinted])];

  let warmNow: Set<string> = new Set();
  let warmNew: string[] = [];
  let warmReasons: Record<string, string[]> = {};
  if (files.length) {
    const result = impact(root, { files, includeUncommitted: false, budget: params.budget });
    const warmedFiles = (result.details.warmedFiles as string[] | undefined) ?? [];
    warmReasons = (result.details.warmedReasons as Record<string, string[]> | undefined) ?? {};
    warmNow = new Set(warmedFiles.filter((file) => !disclosedFiles.has(file) && !files.includes(file)));
    warmNew = prev.warmed === undefined
      ? [...warmNow]
      : [...warmNow].filter((file) => !prev.warmed!.has(file));
  }

  baselines.set(root, { ...snapshot(state), warmed: warmNow });

  const red = (added.length - newlyImplicit.length) + removed.length > 0 ||
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
      },
    };
  }

  const changedSummary = files.length
    ? `${files.slice(0, 4).join(", ")}${files.length > 4 ? ` (+${files.length - 4} more)` : ""}`
    : deleted.length
      ? `${deleted.length} deleted file${deleted.length === 1 ? "" : "s"}`
      : "route structure";
  const orderedWarm = [...warmNew].sort((a, b) =>
    Number(isTestScope(a)) - Number(isTestScope(b)) || a.localeCompare(b));
  const lines: string[] = [
    "Fovea continuous update — repository structure changed.",
    `Changed: ${changedSummary}`,
  ];
  for (const id of added.filter((anchor) => !newlyImplicit.includes(anchor)).slice(0, 6)) {
    lines.push(`Route added: ${id}`);
  }
  for (const id of removed.slice(0, 6)) lines.push(`Route removed: ${id}`);
  if (orderedWarm.length) {
    lines.push("Newly relevant files:");
    for (const file of orderedWarm.slice(0, 8)) {
      lines.push(`  ${file} — ${(warmReasons[file] ?? ["graph path"]).join(", ")}`);
    }
  }
  lines.push("Steer: account for this update before continuing; inspect only the files relevant to the current task.");
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
    },
  };
};
