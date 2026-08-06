// The four operations. Each is: resolve seeds -> diffuse -> reveal within
// budget. sketch surveys the whole repo (large t, hub + anchor seeds, grouped
// rendering), focus centers the fovea on a query, dwell advances diffusion
// time and returns the delta, impact seeds from changed files.

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { hasAstGrepAsync } from "./astgrep.js";
import {
  assembleGraphWithIndex,
  clearPersistTimer,
  filterSupported,
  listFiles,
  loadFacts,
  refreshFacts,
  type ExtractionReport,
  type FactStore,
  type FileFacts,
} from "./build.js";
import { gitProbe, prFiles, uncommittedFiles } from "./git.js";
import { ROOT_CACHE_LIMIT, envInt, yieldToLoop } from "./asyncutil.js";
import { loadRepoRules } from "./anchors.js";
import { buildCsr, chebyshevVectors, chooseOrder, heatField, type Csr } from "./heat.js";
import { formatNodeLocation, revealFoveated, revealGroups, tokenEstimate, type GroupLine, type RevealedNode } from "./render.js";
import { FOCUS_T0, getSession, TK_ORDER } from "./session.js";
import { detectBasins } from "./basins.js";
import { classifyLiteral, normalizeLiteral, type JoinIndex } from "./join.js";
import { isTestFile } from "./extract.js";
import type { Graph, NodeKind, NodeRec } from "./types.js";

export interface OpResult {
  text: string;
  tokens: number;
  details: Record<string, unknown>;
}

export interface RepoState {
  root: string;
  version: string;
  graph: Graph;
  csr: Csr;
  joinIndex: JoinIndex;
  /** facts → FileFacts snapshot for this version; records are immutable per generation. */
  facts: Record<string, FileFacts>;
  /** What extraction dropped on the floor building this graph version. */
  extraction: ExtractionReport;
  adjacency: Map<number, Array<{ to: number; kind: string; w: number }>>;
  /** The live mutation container; facts/meta records are replaced immutably on refresh. */
  store: FactStore;
  /** Authoritative file listing for this version. */
  files: string[];
  gitKind: "git" | "plain";
  head: string | undefined;
  probedAt: number;
  walkedAt: number;
  sweptAt: number;
  /** Porcelain-dirty paths at last probe. Porcelain diffs the worktree against
   * HEAD, but facts track the last seen worktree: a file reverting to
   * porcelain-clean with unmoved HEAD would otherwise keep serving its dirty
   * facts until the next edit. */
  dirty: Set<string>;
}

// State lifecycle: background builds, probe-gated refreshes, LRU eviction.
// pi runs hooks on one JS thread, so ensureState must never block the first
// resolvable answer behind a full rebuild.

const states = new Map<string, RepoState>(); // insertion order doubles as LRU order
const inflight = new Map<string, Promise<RepoState>>();
// Each resident root holds a full fact store + graph; all heavyweight root
// caches use ROOT_CACHE_LIMIT so one override cannot leave hidden retainers.
const WALK_GAP_MS = envInt("FOVEA_WALK_GAP_MS", 4000, 500, 300_000);
const SWEEP_GAP_MS = envInt("FOVEA_SWEEP_GAP_MS", 20_000, 2000, 600_000);

const touch = (root: string): RepoState | undefined => {
  const st = states.get(root);
  if (st) {
    states.delete(root);
    states.set(root, st);
  }
  return st;
};

const evictLru = (): void => {
  while (states.size > ROOT_CACHE_LIMIT) {
    const oldest = states.keys().next().value!;
    states.delete(oldest);
    inflight.delete(oldest);
    clearPersistTimer(oldest);
  }
};

/** Warm state if present (does not block). */
export const getState = (root: string): RepoState | undefined => touch(root);

/** Ongoing build/refresh for root, if any (does not block). */
export const getInflight = (root: string): Promise<RepoState> | undefined => inflight.get(root);

/** Drop resident state (tests); the on-disk fact cache survives. */
export const evictState = (root: string): void => {
  states.delete(root);
  inflight.delete(root);
  clearPersistTimer(root);
};

// All live fact passes serialize through one chain. Extraction-failure
// attribution is a process-wide ledger (astgrep cannot see nested passes),
// so overlapping passes would misblame files — and piled-up ast-grep spawns
// would freeze the host anyway. The chain itself never rejects.
let factChain: Promise<unknown> = Promise.resolve();
const factPass = <T>(job: () => Promise<T>): Promise<T> => {
  const run = factChain.then(job, job);
  factChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const graphVersion = (facts: Record<string, FileFacts>): string =>
  createHash("sha1")
    .update(Object.entries(facts).map(([k, v]) => `${k}:${v.sha1}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 12);

const assembleState = async (
  root: string,
  files: string[],
  store: FactStore,
  extraction: ExtractionReport,
  gitKind: "git" | "plain",
  head: string | undefined,
  dirty: Set<string>,
): Promise<RepoState> => {
  // Snapshot the generation: refresh replaces fact records wholesale, so the
  // Record view stays a stable witness for baselines (sync).
  const facts: Record<string, FileFacts> = {};
  for (const [k, v] of store.facts) facts[k] = v;
  await yieldToLoop();
  const version = graphVersion(facts);
  const { graph, joinIndex } = await assembleGraphWithIndex(root, files, store.facts);
  await yieldToLoop();
  const csr = buildCsr(graph);
  await yieldToLoop();
  const adjacency = new Map<number, Array<{ to: number; kind: string; w: number }>>();
  for (const e of graph.edges) {
    (adjacency.get(e.a) ?? adjacency.set(e.a, []).get(e.a)!).push({ to: e.b, kind: e.kind, w: e.w });
    (adjacency.get(e.b) ?? adjacency.set(e.b, []).get(e.b)!).push({ to: e.a, kind: e.kind, w: e.w });
  }
  // impact's path-reason walk used to sort a fresh copy of this list per
  // visited node; identical comparator, pre-sorted once here.
  for (const list of adjacency.values()) {
    list.sort((a, b) => Number(a.kind === "contains") - Number(b.kind === "contains") || b.w - a.w || a.to - b.to);
  }
  const stamp = Date.now();
  return { root, version, graph, csr, joinIndex, facts, extraction, adjacency, store, files, gitKind, head, dirty, probedAt: stamp, walkedAt: stamp, sweptAt: stamp };
};

const buildState = async (root: string): Promise<RepoState> => {
  if (!(await hasAstGrepAsync())) {
    throw new Error(
      "fovea: `ast-grep` binary not found on PATH (set FOVEA_AST_GREP to override). Install: https://ast-grep.github.io/",
    );
  }
  const { fileRoutes } = await loadRepoRules(root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const probe = await gitProbe(root);
  const gitKind: RepoState["gitKind"] = probe ? "git" : "plain";
  const files = await listFiles(root, routeRes);
  const { store, report } = await factPass(() => loadFacts(root, files));
  return assembleState(root, files, store, report, gitKind, probe?.head,
    new Set(probe ? probe.changes.map((c) => c.path).filter((p) => p && !p.endsWith("/")) : []));
};

const refreshState = async (state: RepoState, hints: string[] = [], force = false): Promise<RepoState> => {
  const now = Date.now();
  // No probe-short-circuit across turns: git porcelain is ~40ms behind the
  // spawn gate and is the correctness oracle; plain roots gate on their own
  // walk/sweep intervals below. In-flight dedupe already coalesces bursts.
  const { fileRoutes } = await loadRepoRules(state.root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const store = state.store;
  let files = state.files;
  const changed: string[] = [];
  const deleted: string[] = [];
  const hinted = [...new Set([...filterSupported(hints, routeRes), ...hints.filter((h) => store.facts.has(h))])];
  changed.push(...hinted);

  if (state.gitKind === "git") {
    const probe = await gitProbe(state.root);
    if (probe) {
      const headMoved = probe.head !== state.head;
      state.head = probe.head;
      // Untracked directories appear collapsed ("dir/") in porcelain; adds
      // inside them only surface through a relist. Relist moments are rare.
      const needsList = probe.relist || probe.changes.some((c) => c.path.endsWith("/"));
      if (needsList) {
        files = await listFiles(state.root, routeRes);
        changed.push(...state.files);
      } else {
        // HEAD moved with a clean status means a checkout: worktree content
        // re-materialized under fresh mtimes, so sweep everything once.
        if (headMoved) changed.push(...state.files);
        for (const c of probe.changes) {
          const p = c.path;
          if (!p || p.endsWith("/")) continue;
          if (c.code.includes("D")) {
            if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
          } else if (store.facts.has(p) || filterSupported([p], routeRes).length) {
            changed.push(p);
          }
        }
      }
      const nowDirty = new Set(
        probe.changes.map((c) => c.path).filter((p) => p && !p.endsWith("/")),
      );
      if (!headMoved && !needsList) {
        // Porcelain-clean with unmoved HEAD hides reverts: a previously dirty
        // file vanishes from the probe while its captured facts stay dirty.
        // Resurrect it once so the snapshot follows the worktree (covers
        // checkout/restore and untracked files that disappear).
        for (const p of state.dirty) {
          if (nowDirty.has(p)) continue;
          // stat is the arbiter: a restored file whose facts were dropped
          // with the deletion must come back through changed, not sit
          // deleted until its next porcelain-visible edit.
          const onDisk = await stat(join(state.root, p)).then((s) => s.isFile(), () => false);
          if (onDisk) changed.push(p);
          else if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
        }
      }
      state.dirty = nowDirty;
    } else {
      // .git vanished (moved/renamed out from under us): degrade to plain.
      state.gitKind = "plain";
    }
  }
  if (state.gitKind === "plain") {
    const walkDue = now - state.walkedAt > WALK_GAP_MS;
    if (force || walkDue || changed.length) {
      files = await listFiles(state.root, routeRes);
      state.walkedAt = now;
      if (force || now - state.sweptAt > SWEEP_GAP_MS) {
        state.sweptAt = now;
        changed.push(...state.files);
      }
    }
  }

  if (!changed.length && !deleted.length && files === state.files) {
    state.probedAt = Date.now();
    return state;
  }
  const { report, stats } = await factPass(() =>
    refreshFacts(state.root, store, files, [...new Set(changed)], [...new Set(deleted)]),
  );
  const noDelta =
    !stats.reExtracted.length && !stats.deleted.length && !stats.added.length && files.length === state.files.length;
  if (noDelta) {
    state.probedAt = Date.now();
    state.extraction = report; // reports are state-wide (taint/unreadable live in the store)
    state.files = files;
    return state;
  }
  const fresh = await assembleState(state.root, files, store, report, state.gitKind, state.head, state.dirty);
  states.set(state.root, fresh);
  return fresh;
};

export const ensureState = (root: string, opts: { hints?: string[]; force?: boolean } = {}): Promise<RepoState> => {
  const pending = inflight.get(root);
  if (pending) return pending;
  const warm = touch(root);
  const p: Promise<RepoState> = warm
    ? refreshState(warm, opts.hints, opts.force)
    : (async () => {
        const st = await stat(root).catch(() => undefined);
        if (!st?.isDirectory()) throw new Error(`fovea: root does not exist or is not a directory: ${root}`);
        const state = await buildState(root);
        states.set(root, state);
        evictLru();
        return state;
      })();
  inflight.set(root, p);
  const clear = (): void => {
    if (inflight.get(root) === p) inflight.delete(root);
  };
  p.then(clear, clear);
  return p;
};

/**
 * Fire-and-forget indexing. started=true when this call kicked a cold build;
 * the completion is always awaitable via the returned promise.
 */
export const ensureStateBackground = (root: string): { started: boolean; promise: Promise<RepoState> } => {
  if (states.has(root) || inflight.has(root)) {
    return { started: false, promise: ensureState(root) };
  }
  return { started: true, promise: ensureState(root) };
};

// Honest coverage: surface dropped extractions instead of letting a thin
// graph read as a small repo. Suffixes go into rendered headers; the file
// lists go into structured details for consumers that can act on them.
const extractionSuffix = (state: RepoState): string => {
  const parts: string[] = [];
  if (state.extraction.failed.length) parts.push(`!${state.extraction.failed.length} files failed extraction`);
  if (state.extraction.unreadable.length) parts.push(`!${state.extraction.unreadable.length} files unreadable`);
  if (state.extraction.oversized.length) parts.push(`!${state.extraction.oversized.length} files over size cap`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
};

const extractionDetails = (state: RepoState): Record<string, unknown> => ({
  extractionFailures: state.extraction.failed.length,
  extractionFailedFiles: state.extraction.failed.slice(0, 20),
  extractionUnreadable: state.extraction.unreadable,
  extractionOversized: state.extraction.oversized,
});

// Seed resolution.

export interface SeedSuggestion {
  index: number;
  name: string;
  file: string;
  line: number;
  lineApproximate?: boolean;
  score: number;
}

export interface SeedResolution {
  seeds: number[];
  note: string;
  suggestions: SeedSuggestion[];
}

export interface FocusOptions {
  fresh?: boolean;
  path?: string;
  language?: string;
  kind?: NodeKind;
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "does", "find", "for", "happen", "happens", "how",
  "in", "is", "of", "on", "please", "the", "this", "to", "what", "where", "which", "with",
]);

const stemIdentifier = (term: string): string => {
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
};

const identifierTerms = (value: string): string[] => {
  const split = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !QUERY_STOP_WORDS.has(term))
    .map(stemIdentifier)
    .filter((term) => !QUERY_STOP_WORDS.has(term));
  return [...new Set(split)];
};

const shortSymbolName = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

const diceSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    left.set(pair, (left.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const count = left.get(pair) ?? 0;
    if (count > 0) {
      overlap++;
      left.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
};

const symbolSimilarity = (query: string, node: NodeRec): number => {
  const queryTerms = identifierTerms(query);
  const candidateTerms = identifierTerms(shortSymbolName(node.name));
  const candidateSet = new Set(candidateTerms);
  const shared = queryTerms.filter((term) => candidateSet.has(term)).length;
  const coverage = queryTerms.length ? shared / queryTerms.length : 0;
  const precision = candidateTerms.length ? shared / candidateTerms.length : 0;
  const tokenScore = 0.72 * coverage + 0.28 * precision;
  const charScore = diceSimilarity(queryTerms.join(""), candidateTerms.join(""));
  return Math.max(tokenScore, charScore);
};

const sameIdentifierTerms = (query: string, name: string): boolean => {
  const queryTerms = identifierTerms(query);
  const candidateTerms = identifierTerms(shortSymbolName(name));
  if (!queryTerms.length || queryTerms.length !== candidateTerms.length) return false;
  const candidateSet = new Set(candidateTerms);
  return queryTerms.every((term) => candidateSet.has(term));
};

const matchesFocusScope = (node: NodeRec, options: FocusOptions): boolean => {
  const pathScope = options.path?.replace(/^@/, "").replace(/^\.\//, "").replace(/\/$/, "");
  if (pathScope && node.file !== pathScope && !node.file.startsWith(`${pathScope}/`)) return false;
  if (options.language && node.lang.toLowerCase() !== options.language.toLowerCase()) return false;
  if (options.kind && node.kind !== options.kind) return false;
  return true;
};

export const resolveSeeds = (state: RepoState, query: string, options: FocusOptions = {}): SeedResolution => {
  const g = state.graph;
  const allows = (idx: number): boolean => matchesFocusScope(g.nodes[idx]!, options);
  const scored = new Map<number, number>();
  const bump = (idx: number, s: number): void => {
    if (!allows(idx)) return;
    scored.set(idx, Math.max(scored.get(idx) ?? 0, s));
  };
  const q = query.trim();
  const terms = q.split(/\s+/).filter((t) => t.length > 1);

  // Literal route: treat the query itself as a join token (path/env/word).
  const cls = classifyLiteral(q);
  if (cls) {
    const norm = normalizeLiteral(q, cls);
    for (const occ of state.joinIndex.byKey.get(norm)?.occ ?? []) bump(occ.node, 1);
    if (cls === "path") {
      // Route-prefix queries ("/api/airports") seed everything mounted below
      // them — the query is rarely a literal in code, which is the point: the
      // model shouldn't have to guess the full route string to look at it.
      const under = `${norm}/`;
      for (const [key, bucket] of state.joinIndex.byKey) {
        if (bucket.cls !== "path" || !key.startsWith(under)) continue;
        for (const occ of bucket.occ) bump(occ.node, 0.8);
      }
      // Anchors whose route sits under the query get seeded directly.
      state.graph.nodes.forEach((n, i) => {
        if (n.kind !== "anchor") return;
        const route = n.name.slice(n.name.indexOf(" ") + 1);
        if (route === norm || route.startsWith(under)) bump(i, 0.9);
      });
    }
  }

  for (const term of terms) {
    const key = term.toLowerCase();
    for (const idx of g.byName.get(key) ?? []) bump(idx, 1);
  }
  if (scored.size === 0) {
    // Substring fallback over symbol names.
    const hay: Array<{ i: number; name: string }> = [];
    g.nodes.forEach((n, i) => {
      if (n.kind !== "file" && n.kind !== "anchor") hay.push({ i, name: n.name.toLowerCase() });
    });
    for (const term of terms) {
      const key = term.toLowerCase();
      for (const { i, name } of hay) {
        if (name === key) bump(i, 1);
        else if (name.startsWith(key)) bump(i, 0.8);
        else if (name.includes(key)) bump(i, 0.5);
      }
    }
  }
  if (scored.size === 0) {
    g.nodes.forEach((node, i) => {
      if (node.kind !== "file" && node.kind !== "anchor" && sameIdentifierTerms(q, node.name)) {
        bump(i, 0.7);
      }
    });
  }
  // File path suffix (e.g. "web/api.ts").
  for (const f of g.files) {
    if (f === q || f.endsWith(`/${q}`)) {
      const arr = g.byFile.get(f) ?? [];
      if (arr[0] !== undefined) bump(arr[0], 1);
    }
  }

  const ranked = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || g.nodes[a[0]]!.file.localeCompare(g.nodes[b[0]]!.file))
    .slice(0, 16);
  const seeds = ranked.map(([i]) => i);
  const names = ranked.slice(0, 4).map(([i, score]) => `${g.nodes[i]!.name}${score < 1 ? " (approximate)" : ""}`);
  const note = seeds.length
    ? `${seeds.length} match${seeds.length === 1 ? "" : "es"}: ${names.join(", ")}${seeds.length > 4 ? ", …" : ""}`
    : "no graph match";
  const suggestions = seeds.length
    ? []
    : g.nodes
      .map((node, index) => ({ node, index, score: symbolSimilarity(q, node) }))
      .filter(({ node, index, score }) => allows(index) && node.kind !== "file" && node.kind !== "anchor" && score >= 0.34)
      .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name) || a.node.file.localeCompare(b.node.file))
      .slice(0, 5)
      .map(({ node, index, score }) => ({
        index,
        name: node.name,
        file: node.file,
        line: node.line,
        lineApproximate: node.lineApproximate,
        score,
      }));
  return { seeds, note, suggestions };
};

const suggestedReads = (nodes: RevealedNode[]): Array<{ path: string; offset: number; limit: number; reason: string }> => {
  const out: Array<{ path: string; offset: number; limit: number; reason: string }> = [];
  for (const node of nodes) {
    if (node.line <= 0 || node.lineApproximate) continue;
    const offset = Math.max(1, node.line - 5);
    const end = offset + 24;
    const existing = out.find((read) =>
      read.path === node.file && offset <= read.offset + read.limit && end + 1 >= read.offset);
    if (existing) {
      const mergedEnd = Math.max(existing.offset + existing.limit - 1, end);
      existing.offset = Math.min(existing.offset, offset);
      existing.limit = mergedEnd - existing.offset + 1;
      if (node.role === "focus") existing.reason = "matched focus";
      continue;
    }
    out.push({
      path: node.file,
      offset,
      limit: 25,
      reason: node.role === "focus" ? "matched focus" : node.relation ?? `${node.role} neighbor`,
    });
    if (out.length === 5) break;
  }
  return out;
};

const seedVector = (n: number, seeds: number[]): Float64Array => {
  const s = new Float64Array(n);
  for (const i of seeds) s[i] = 1;
  return s;
};

const clampBudget = (b: number | undefined, dflt: number): number =>
  Math.max(256, Math.min(16000, b ?? dflt));

export const isTestScope = (file: string): boolean =>
  isTestFile(file) || /(^|\/)(tests?|__tests__|fixtures?)(\/|$)/i.test(file);


export const sketch = async (root: string, budget?: number): Promise<OpResult> => {
  const state = await ensureState(root);
  const g = state.graph;
  const B = clampBudget(budget, 1400);

  // Production anchors and hubs define the opening silhouette. Tests remain
  // in the graph for focus/impact, but do not crowd out the code being shipped.
  const conductance = state.csr.deg;
  const closureFor = (i: number): number[] => [i, ...(state.adjacency.get(i) ?? []).map((edge) => edge.to)];
  const anchorIdx = g.nodes.map((node, i) => (node.kind === "anchor" ? i : -1)).filter((i) => i >= 0);
  const productionAnchorIdx = anchorIdx.filter((i) => closureFor(i).some((j) => !isTestScope(g.nodes[j]!.file)));
  const testAnchorIdx = anchorIdx.filter((i) => !productionAnchorIdx.includes(i));
  const productionHubIdx = g.nodes
    .map((_, i) => i)
    .filter((i) => !isTestScope(g.nodes[i]!.file))
    .sort((a, b) => conductance[b]! - conductance[a]!)
    .slice(0, 24);
  const fallbackHubIdx = productionHubIdx.length
    ? productionHubIdx
    : g.nodes.map((_, i) => i).sort((a, b) => conductance[b]! - conductance[a]!).slice(0, 24);
  const seeds = [...new Set([...productionAnchorIdx, ...fallbackHubIdx])].slice(0, 64);
  const s = seedVector(g.nodes.length, seeds);
  const t = 16;
  const field = heatField(chebyshevVectors(state.csr, s, Math.max(TK_ORDER, chooseOrder(t))), t, g.nodes.length);
  let vmax = 0;
  for (let i = 0; i < field.length; i++) if (field[i]! > vmax) vmax = field[i]!;
  if (vmax <= 0) {
    return { text: "fovea sketch: empty graph (no supported files matched)", tokens: 0, details: { files: 0 } };
  }

  // Feature groups: anchors first; where the repo declares few routes,
  // infer basins — greedy conductance-cut regions around self-dense seeds
  // (implicit features on non-web repos: CLIs, libraries, kernels).
  const claimed = new Set<number>();
  const groups: GroupLine[] = [];
  const basins = productionAnchorIdx.length < 6 && g.nodes.length >= 48
    ? detectBasins(
        state.adjacency,
        conductance,
        g.nodes.length,
        (i) => g.nodes[i]!.kind !== "file" && g.nodes[i]!.kind !== "anchor" && !isTestScope(g.nodes[i]!.file),
        (i) => !isTestScope(g.nodes[i]!.file),
      )
    : [];
  for (const b of basins) {
    let mass = 0;
    const bfiles = new Set<string>();
    for (const j of b.members) {
      mass += field[j] ?? 0;
      bfiles.add(g.nodes[j]!.file);
    }
    const topName = b.members
      .map((j) => [field[j] ?? 0, j] as const)
      .filter(([, j]) => g.nodes[j]!.kind !== "file")
      .sort((a, b2) => b2[0] - a[0])[0];
    groups.push({
      label: `◈ region ${topName ? g.nodes[topName[1]]!.name : g.nodes[b.seed]!.name}`,
      mass,
      detail: `${b.members.length} nodes · ${bfiles.size} files · seed ${g.nodes[b.seed]!.file}`,
    });
    for (const j of b.members) claimed.add(j);
  }

  for (const i of productionAnchorIdx) {
    const closure = closureFor(i);
    let mass = 0;
    const filesIn = new Set<string>();
    for (const j of closure) {
      mass += field[j]!;
      filesIn.add(g.nodes[j]!.file);
      claimed.add(j);
    }
    const handler = g.nodes[i]!;
    groups.push({
      label: `⚑ ${g.nodes[i]!.name}`,
      mass,
      detail: `${closure.length} nodes · ${filesIn.size} file${filesIn.size === 1 ? "" : "s"} · ${handler.file}:${handler.line}`,
    });
  }

  let testAnchorMass = 0;
  for (const i of testAnchorIdx) {
    for (const j of closureFor(i)) {
      testAnchorMass += field[j] ?? 0;
      claimed.add(j);
    }
  }
  if (testAnchorIdx.length) {
    groups.push({
      label: "tests/fixtures",
      mass: testAnchorMass * 0.05,
      detail: `${testAnchorIdx.length} feature anchors collapsed`,
    });
  }

  // Directory groups over the rest (depth-2 prefixes).
  const dirAgg = new Map<string, { mass: number; files: Set<string>; top: Array<[number, number]> }>();
  g.nodes.forEach((n, i) => {
    if (claimed.has(i) || n.kind === "anchor") return;
    const parts = n.file.split("/");
    const dir = parts.length === 1 ? "(root)" : parts.length === 2 ? `${parts[0]}/` : `${parts.slice(0, 2).join("/")}/`;
    const agg = dirAgg.get(dir) ?? { mass: 0, files: new Set<string>(), top: [] as Array<[number, number]> };
    dirAgg.set(dir, agg);
    agg.mass += field[i]!;
    agg.files.add(n.file);
    if (n.kind !== "file") agg.top.push([field[i]!, i]);
  });
  for (const [dir, agg] of dirAgg) {
    agg.top.sort((a, b) => b[0] - a[0]);
    const names = agg.top.slice(0, 3).map(([, i]) => g.nodes[i]!.name).join(", ");
    const testScope = [...agg.files].every(isTestScope);
    groups.push({
      label: dir,
      mass: agg.mass * (testScope ? 0.1 : 1),
      detail: `${testScope ? "test scope · " : ""}${agg.files.size} files${names ? ` · top: ${names}` : ""}`,
    });
  }

  const anchorSummary = testAnchorIdx.length
    ? `${productionAnchorIdx.length} production anchors · ${testAnchorIdx.length} test/fixture anchors collapsed`
    : `${productionAnchorIdx.length} anchors`;
  const fit = revealGroups(groups, {
    header: `fovea sketch · ${g.files.length} files · ${g.nodes.length} symbols · ${anchorSummary}${extractionSuffix(state)}`,
    budget: B,
  });
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      files: g.files.length,
      nodes: g.nodes.length,
      anchors: anchorIdx.length,
      productionAnchors: productionAnchorIdx.length,
      testAnchors: testAnchorIdx.length,
      truncated: fit.truncated,
      ...extractionDetails(state),
    },
  };
};

export const focus = async (root: string, query: string, budget?: number, options: FocusOptions = {}): Promise<OpResult> => {
  const state = await ensureState(root);
  const g = state.graph;
  const session = getSession(root);
  const B = clampBudget(budget, 2000);
  const { seeds, note, suggestions } = resolveSeeds(state, query, options);
  if (!seeds.length) {
    const renderMiss = (count: number): string => {
      const nearby = suggestions.slice(0, count).map((suggestion) => {
        const node = g.nodes[suggestion.index]!;
        return `  ? ${node.name} — ${formatNodeLocation(node)} — ${node.sig}`;
      });
      const guidance = suggestions.length
        ? "Retry fovea_focus with one of these names, a route path (/api/...), or a file path."
        : "Try a symbol name, a route path (/api/...), or a file path. Run fovea_sketch for the map silhouette first.";
      return [
        ...(state.extraction.failed.length
          ? [`! ${state.extraction.failed.length} files failed extraction; matches may be incomplete.`]
          : []),
        `fovea focus "${query}": ${note}.`,
        ...(nearby.length ? ["Nearby symbols:", ...nearby] : []),
        guidance,
      ].join("\n");
    };
    let shown = suggestions.length;
    let text = renderMiss(shown);
    while (shown > 0 && tokenEstimate(text) > B) text = renderMiss(--shown);
    return {
      text,
      tokens: tokenEstimate(text),
      details: {
        seeds: 0,
        suggestions: suggestions.slice(0, shown).map(({ name, file, line, lineApproximate, score }) => ({
          name,
          file,
          line,
          lineApproximate,
          score: Number(score.toFixed(3)),
        })),
        scope: { path: options.path, language: options.language, kind: options.kind },
        ...extractionDetails(state),
      },
    };
  }
  const scopeKey = [options.path ?? "", options.language?.toLowerCase() ?? "", options.kind ?? ""].join("|");
  const key = `${state.version}:${[...seeds].sort((a, b) => a - b).join(",")}:${scopeKey}`;
  if (options.fresh || session.focusKey !== key) {
    session.t = FOCUS_T0;
    session.disclosed.clear();
    session.focusKey = key;
    session.scope = { path: options.path, language: options.language, kind: options.kind };
  }
  if (session.tkKey !== key) {
    session.tk = chebyshevVectors(state.csr, seedVector(g.nodes.length, seeds), TK_ORDER);
    session.tkKey = key;
  }
  session.seeds = seeds;
  session.seedNote = note;
  const t = session.t;
  const field = heatField(session.tk, t, g.nodes.length);
  const scopedIds = options.path || options.language || options.kind
    ? new Set(g.nodes.filter((node) => matchesFocusScope(node, options)).map((node) => node.id))
    : undefined;
  const fit = revealFoveated(g, field, {
    header: `fovea focus "${query}" · ${note}${extractionSuffix(state)}`,
    include: scopedIds,
    disclosed: session.disclosed,
    seeds,
    repeatNucleus: true,
    budget: B,
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      seeds: seeds.length,
      lit: fit.litTotal,
      shown: fit.shown,
      suppressed: fit.suppressed,
      t,
      scope: { path: options.path, language: options.language, kind: options.kind },
      nodes: fit.revealed,
      suggestedReads: suggestedReads(fit.revealed),
      ...extractionDetails(state),
    },
  };
};

export const dwell = async (root: string, factor?: number, budget?: number): Promise<OpResult> => {
  const state = await ensureState(root);
  const g = state.graph;
  const session = getSession(root);
  const B = clampBudget(budget, 2000);
  if (!session.seeds.length) {
    return {
      text: "fovea dwell: no focus yet. Call fovea_focus with a symbol or route first; dwell then deepens that field.",
      tokens: 0,
      details: { seeds: 0 },
    };
  }
  const from = session.t;
  const to = Math.min(64, from * Math.max(1.2, factor ?? 2));
  session.t = to;
  // The cached T_k(M)s vectors are exact for t up to ~TK_ORDER/2.2-16; beyond
  // that, extend the recurrence instead of silently degrading accuracy.
  if (chooseOrder(to) > session.tk.length - 1) {
    session.tk = chebyshevVectors(state.csr, seedVector(g.nodes.length, session.seeds), chooseOrder(to) + 8);
    session.tkKey += "+ext";
  }
  const field = heatField(session.tk, to, g.nodes.length);
  const scope = session.scope ?? {};
  const scopedIds = scope.path || scope.language || scope.kind
    ? new Set(g.nodes.filter((node) => matchesFocusScope(node, scope)).map((node) => node.id))
    : undefined;
  const fit = revealFoveated(g, field, {
    header: `fovea dwell · context widened ${Number((to / from).toFixed(1))}× · new results`,
    include: scopedIds,
    disclosed: session.disclosed,
    seeds: session.seeds,
    budget: B,
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      from,
      to,
      lit: fit.litTotal,
      shown: fit.shown,
      suppressed: fit.suppressed,
      scope,
      nodes: fit.revealed,
      suggestedReads: suggestedReads(fit.revealed),
      ...extractionDetails(state),
    },
  };
};

export interface ImpactArgs {
  files?: string[];
  symbols?: string[];
  includeUncommitted?: boolean;
  /** Base ref for PR-style cascades: seeds from `git diff base...HEAD`. */
  base?: string;
  budget?: number;
}

export const impact = async (root: string, args: ImpactArgs, ensured?: RepoState): Promise<OpResult> => {
  const state = ensured ?? (await ensureState(root));
  const g = state.graph;
  const B = clampBudget(args.budget, 2000);
  const files = new Set<string>(args.files ?? []);
  if (args.base) for (const f of await prFiles(root, args.base)) files.add(f);
  if (args.includeUncommitted !== false && !args.base) for (const f of await uncommittedFiles(root)) files.add(f);

  const seedSet = new Set<number>();
  for (const rel of files) {
    const arr = g.byFile.get(rel) ?? g.byFile.get(posix.normalize(rel)) ?? [];
    if (arr[0] !== undefined) seedSet.add(arr[0]);
  }
  for (const sym of args.symbols ?? []) {
    for (const r of resolveSeeds(state, sym).seeds) seedSet.add(r);
  }
  if (!seedSet.size) {
    return {
      text: "fovea impact: no seed files (repo clean or paths unknown). Pass files: [...] or symbols: [...] for a what-if cascade.",
      tokens: 0,
      details: { seeds: 0 },
    };
  }
  const seeds = [...seedSet];
  const t = 4;
  const field = heatField(chebyshevVectors(state.csr, seedVector(g.nodes.length, seeds), chooseOrder(t)), t, g.nodes.length);
  const exclude = new Set(seeds.map((i) => g.nodes[i]!.id));
  const seedFiles = new Set(seeds.map((i) => g.nodes[i]!.file));

  // Aggregate warmed mass per file (excluding the seeds themselves).
  const fileAgg = new Map<string, number>();
  const fileTop = new Map<string, Array<[number, number]>>();
  const anchorHits: GroupLine[] = [];
  g.nodes.forEach((n, i) => {
    if (exclude.has(n.id) || seedFiles.has(n.file)) return;
    const v = field[i]!;
    if (v <= 1e-6) return;
    if (n.kind === "anchor") {
      anchorHits.push({ label: `⚑ ${n.name}`, mass: v, detail: `${n.file}:${n.line}` });
      return;
    }
    fileAgg.set(n.file, (fileAgg.get(n.file) ?? 0) + v);
    if (n.kind === "file") return; // file nodes warm their file but aren't "top symbols"
    const top = fileTop.get(n.file) ?? [];
    fileTop.set(n.file, top);
    top.push([v, i]);
  });
  const reasonByFile = new Map<string, Set<string>>();
  const reasonFor = (kind: Graph["edges"][number]["kind"]): string | undefined => {
    switch (kind) {
      case "invokes": return "call dependency";
      case "imports": return "import dependency";
      case "tests": return "test dependency";
      case "inherits": return "inheritance";
      case "join": return "shared literal";
      case "anchors": return "shared route";
      case "cochange": return "co-change history";
      case "contains": return undefined;
    }
  };
  for (const edge of g.edges) {
    const aFile = g.nodes[edge.a]!.file;
    const bFile = g.nodes[edge.b]!.file;
    if (aFile === bFile) continue;
    const target = seedFiles.has(aFile) && !seedFiles.has(bFile)
      ? bFile
      : seedFiles.has(bFile) && !seedFiles.has(aFile)
        ? aFile
        : undefined;
    const reason = reasonFor(edge.kind);
    if (!target || !reason || !fileAgg.has(target)) continue;
    const reasons = reasonByFile.get(target) ?? new Set<string>();
    reasons.add(reason);
    reasonByFile.set(target, reasons);
  }

  // Files beyond one hop still need an explanation. Walk the unweighted
  // shortest paths once from all seeds, preserving semantic edge kinds while
  // omitting same-file containment hops from the user-facing reason.
  const visited = new Set(seeds);
  const queue = seeds.map((node) => ({ node, reasons: [] as string[] }));
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const edge of state.adjacency.get(current.node) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const reason = reasonFor(edge.kind as Graph["edges"][number]["kind"]);
      const reasons = reason && !current.reasons.includes(reason)
        ? [...current.reasons, reason]
        : current.reasons;
      queue.push({ node: edge.to, reasons });
      const file = g.nodes[edge.to]!.file;
      if (fileAgg.has(file) && !seedFiles.has(file) && !reasonByFile.has(file) && reasons.length) {
        reasonByFile.set(file, new Set(reasons.slice(0, 3)));
      }
    }
  }

  const fileEntries = [...fileAgg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const fileGroups: GroupLine[] = [];
  for (const [file, mass] of fileEntries) {
    const top = (fileTop.get(file) ?? [])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([, i]) => g.nodes[i]!.name)
      .join(", ");
    const reasons = [...(reasonByFile.get(file) ?? new Set(["graph path"]))];
    fileGroups.push({
      label: file,
      mass,
      detail: `via ${reasons.join(", ")}${top ? ` · top: ${top}` : ""}`,
    });
  }
  const groups: GroupLine[] = [...anchorHits, ...fileGroups];
  const seedNames = seeds.slice(0, 5).map((i) => g.nodes[i]!.file).join(", ");
  const fit = revealGroups(groups, {
    header: `fovea impact · changed: ${seedNames}${seeds.length > 5 ? ", …" : ""} · likely review order`,
    budget: B,
  });
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      seeds: seeds.length,
      warmed: groups.length,
      truncated: fit.truncated,
      ...extractionDetails(state),
      // Structured form for consumers (turn-sync): warmed anchors, files,
      // and the strongest direct evidence channel without text re-parsing.
      warmedAnchors: anchorHits.map((h) => h.label.replace(/^⚑\s*/, "")),
      warmedFiles: fileEntries.map(([file]) => file),
      warmedReasons: Object.fromEntries(fileEntries.map(([file]) => [
        file,
        [...(reasonByFile.get(file) ?? new Set(["graph path"]))],
      ])),
    },
  };
};

// For tests and benches: token estimate passthrough.
export const estimateTokens = tokenEstimate;
