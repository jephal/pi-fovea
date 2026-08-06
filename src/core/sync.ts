// Turn-sync: the default-on feedback loop the extension was built around.
// After each assistant turn, if the repo's facts version drifted ANY edit
// re-syncs, regardless of the mutation path — pi's edit/write tools, a
// fabric_exec inner pi.edit, a bash heredoc, a subagent run, or an editor
// save outside the session all land the same way, because drift is measured
// by diffing the baseline's content hashes against the current facts instead
// of trusting tool events or git.
//
//   red  = route anchors appeared/vanished   (structural feature churn)
//       OR warm undisclosed files >= warmFileThreshold  (unseen blast radius)
//   green = structure stable; zero model tokens unless ackClean is on
//
// The first sync of a session only establishes the baseline (never red).
// Baselines reset on /new and /fork alongside fovea sessions.

import { ensureState, impact } from "./ops.js";
import type { RepoState } from "./ops.js";
import { getSession } from "./session.js";

interface SyncBaseline {
  version: string;
  anchors: Set<string>;
  /** file -> content sha1 at baseline. Diffing this against the current facts
   * yields the exact changed-file set for any mutation path — no dependence
   * on which tool executed the write, nor on git. */
  shas: Map<string, string>;
  /** Steady-state warmth recorded on the most recent sync. undefined = "the
   * first drift after baseline calibrates the neighborhood instead of
   * escalating" — a file list appears after that calibration sync. */
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

const snapshot = (state: RepoState): SyncBaseline => ({
  version: state.version,
  anchors: new Set(state.graph.anchors.map((a) => a.id)),
  shas: new Map(Object.entries(state.facts).map(([f, x]) => [f, x.sha1])),
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
  const hinted = (params.files ?? []).filter((f) => state.graph.byFile.has(f));
  const changed = Object.keys(state.facts).filter(
    (f) => prev.shas.get(f) !== state.facts[f]!.sha1 && state.graph.byFile.has(f),
  );
  const deleted = [...prev.shas.keys()].filter((f) => !(f in state.facts));
  const files = [...new Set([...hinted, ...changed])];

  let warmNow: Set<string> = new Set();
  let warmNew: string[] = [];
  if (files.length) {
    const r = impact(root, { files, budget: params.budget });
    const warmedFiles = (r.details.warmedFiles as string[] | undefined) ?? [];
    warmNow = new Set(warmedFiles.filter((f) => !disclosedFiles.has(f) && !files.includes(f)));
    warmNew = prev.warmed === undefined
      ? []                                  // first drift after baseline: calibrate, don't escalate
      : [...warmNow].filter((f) => !prev.warmed!.has(f));
  }

  baselines.set(root, { ...snapshot(state), warmed: warmNow });

  const red = (added.length - newlyImplicit.length) + removed.length > 0 || warmNew.length >= Math.max(1, params.warmFileThreshold);
  if (!red) {
    return {
      structural: true, red: false, tokens: 0,
      details: { version: state.version, anchorsDelta: added.length - removed.length, warmNew: warmNew.length, deletedFiles: deleted },
    };
  }

  const lines: string[] = [];
  lines.push(`fovea sync · v ${state.version} · edit cascade did not stay local`);
  for (const id of added.filter((a) => !newlyImplicit.includes(a)).slice(0, 12)) lines.push(`  ⚑=new ${id}`);
  for (const id of newlyImplicit.slice(0, 6)) lines.push(`  △ newly discovered hub ${id}`);
  for (const id of removed.slice(0, 12)) lines.push(`  ⚑-removed ${id}`);
  if (warmNew.length) {
    lines.push(`  newly warm undisclosed files (revisit with fovea_focus):`);
    for (const f of warmNew.slice(0, 20)) lines.push(`    ${f}`);
  }
  const text = lines.join("\n");
  return {
    structural: true, red: true, text, tokens: Math.ceil(text.length / 4),
    details: { version: state.version, added, removed, warmNew, deletedFiles: deleted },
  };
};
