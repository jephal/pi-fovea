// The four operations. Each is: resolve seeds -> diffuse -> reveal within
// budget. sketch surveys the whole repo (large t, hub + anchor seeds, grouped
// rendering), focus centers the fovea on a query, dwell advances diffusion
// time and returns the delta, impact seeds from changed files.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { hasAstGrep } from "./astgrep.js";
import { assembleGraph, listFiles, loadFacts, type FileFacts } from "./build.js";
import { loadRepoRules } from "./anchors.js";
import { buildCsr, chebyshevVectors, chooseOrder, heatField, type Csr } from "./heat.js";
import { formatNodeLocation, revealFoveated, revealGroups, tokenEstimate, type GroupLine } from "./render.js";
import { getSession, TK_ORDER } from "./session.js";
import { detectBasins } from "./basins.js";
import { classifyLiteral, normalizeLiteral, buildJoinIndex, type JoinIndex } from "./join.js";
import type { Graph, NodeRec } from "./types.js";

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
  facts: Record<string, FileFacts>;
  adjacency: Map<number, Array<{ to: number; kind: string; w: number }>>;
}

const states = new Map<string, RepoState>();

const graphVersion = (facts: Record<string, FileFacts>): string =>
  createHash("sha1")
    .update(Object.entries(facts).map(([k, v]) => `${k}:${v.sha1}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 12);

export const ensureState = (root: string): RepoState => {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`fovea: root does not exist or is not a directory: ${root}`);
  }
  if (!hasAstGrep()) {
    throw new Error(
      "fovea: `ast-grep` binary not found on PATH (set FOVEA_AST_GREP to override). Install: https://ast-grep.github.io/",
    );
  }
  const { fileRoutes } = loadRepoRules(root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const files = listFiles(root, routeRes);
  const facts = loadFacts(root, files);
  const version = graphVersion(facts);
  const cached = states.get(root);
  if (cached && cached.version === version) return cached;
  const graph = assembleGraph(root, files, facts);
  const csr = buildCsr(graph);
  const sites = Object.values(facts).flatMap((f) => f.literals);
  const joinIndex = buildJoinIndex(sites, (file, line) => {
    const arr = graph.byFile.get(file) ?? [];
    let best = arr[0];
    for (const idx of arr) {
      const n = graph.nodes[idx]!;
      if (n.kind !== "file" && n.line <= line) best = idx;
    }
    return best;
  });
  const adjacency = new Map<number, Array<{ to: number; kind: string; w: number }>>();
  for (const e of graph.edges) {
    (adjacency.get(e.a) ?? adjacency.set(e.a, []).get(e.a)!).push({ to: e.b, kind: e.kind, w: e.w });
    (adjacency.get(e.b) ?? adjacency.set(e.b, []).get(e.b)!).push({ to: e.a, kind: e.kind, w: e.w });
  }
  const state: RepoState = { root, version, graph, csr, joinIndex, facts, adjacency };
  states.set(root, state);
  return state;
};

// --- seed resolution ------------------------------------------------------------

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

export const resolveSeeds = (state: RepoState, query: string): SeedResolution => {
  const g = state.graph;
  const scored = new Map<number, number>();
  const bump = (idx: number, s: number): void => {
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
  const names = ranked.slice(0, 4).map(([i, s]) => `${g.nodes[i]!.name}${s < 1 ? "~" : ""}`);
  const note = seeds.length ? `${seeds.length} seeds (${names.join(", ")}${seeds.length > 4 ? ", …" : ""})` : "no seeds matched";
  const suggestions = seeds.length
    ? []
    : g.nodes
      .map((node, index) => ({ node, index, score: symbolSimilarity(q, node) }))
      .filter(({ node, score }) => node.kind !== "file" && node.kind !== "anchor" && score >= 0.34)
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

const seedVector = (n: number, seeds: number[]): Float64Array => {
  const s = new Float64Array(n);
  for (const i of seeds) s[i] = 1;
  return s;
};

const clampBudget = (b: number | undefined, dflt: number): number =>
  Math.max(256, Math.min(16000, b ?? dflt));

// --- ops ------------------------------------------------------------------------

export const sketch = (root: string, budget?: number): OpResult => {
  const state = ensureState(root);
  const g = state.graph;
  const B = clampBudget(budget, 1400);

  // Seeds: anchors (features) + high-conductance hub nodes.
  const conductance = state.csr.deg;
  const hubIdx = g.nodes
    .map((_, i) => i)
    .sort((a, b) => conductance[b]! - conductance[a]!)
    .slice(0, 24);
  const anchorIdx = g.nodes.map((n, i) => (n.kind === "anchor" ? i : -1)).filter((i) => i >= 0);
  const seeds = [...new Set([...anchorIdx, ...hubIdx])].slice(0, 64);
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
  const basins = g.anchors.length < 6 && g.nodes.length >= 48
    ? detectBasins(
        state.adjacency,
        conductance,
        g.nodes.length,
        (i) => g.nodes[i]!.kind !== "file" && g.nodes[i]!.kind !== "anchor",
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
      label: `◈ basin ${topName ? g.nodes[topName[1]]!.name : g.nodes[b.seed]!.name}`,
      mass,
      detail: `${b.members.length} nodes · ${bfiles.size} files · seed ${g.nodes[b.seed]!.file}`,
    });
    for (const j of b.members) claimed.add(j);
  }

  for (const i of anchorIdx) {
    const closure = [i, ...(state.adjacency.get(i) ?? []).map((e) => e.to)];
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
    groups.push({ label: dir, mass: agg.mass, detail: `${agg.files.size} files${names ? ` · top: ${names}` : ""}` });
  }

  const fit = revealGroups(groups, { header: `fovea sketch · t=${t} · ${g.files.length} files · ${g.nodes.length} nodes · ${anchorIdx.length} anchors`, budget: B });
  return { text: fit.text, tokens: fit.tokens, details: { files: g.files.length, nodes: g.nodes.length, anchors: anchorIdx.length, truncated: fit.truncated } };
};

export const focus = (root: string, query: string, budget?: number): OpResult => {
  const state = ensureState(root);
  const g = state.graph;
  const session = getSession(root);
  const B = clampBudget(budget, 2000);
  const { seeds, note, suggestions } = resolveSeeds(state, query);
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
      },
    };
  }
  const key = `${state.version}:${[...seeds].sort((a, b) => a - b).join(",")}`;
  if (session.tkKey !== key) {
    session.tk = chebyshevVectors(state.csr, seedVector(g.nodes.length, seeds), TK_ORDER);
    session.tkKey = key;
  }
  session.seeds = seeds;
  session.seedNote = note;
  const t = session.t;
  const field = heatField(session.tk, t, g.nodes.length);
  const fit = revealFoveated(g, field, {
    header: `fovea focus "${query}" · ${note} · t=${t}`,
    disclosed: session.disclosed,
    seeds,
    budget: B,
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: { seeds: seeds.length, lit: fit.litTotal, shown: fit.shown, suppressed: fit.suppressed, t },
  };
};

export const dwell = (root: string, factor?: number, budget?: number): OpResult => {
  const state = ensureState(root);
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
  const fit = revealFoveated(g, field, {
    header: `fovea dwell · t ${from}→${to} · delta`,
    disclosed: session.disclosed,
    seeds: session.seeds,
    budget: B,
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: { from, to, lit: fit.litTotal, shown: fit.shown, suppressed: fit.suppressed },
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

export const uncommittedFiles = (root: string): string[] => {
  const res = spawnSync("git", ["-C", root, "status", "--porcelain", "-z"], { encoding: "utf8", timeout: 15_000 });
  if (res.error || res.status !== 0 || !res.stdout) return [];
  const out: string[] = [];
  for (const entry of res.stdout.split("\0")) {
    if (!entry) continue;
    const path = entry.slice(3);
    const arrow = path.indexOf(" -> ");
    out.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return out.filter(Boolean);
};

const prFiles = (root: string, base: string): string[] => {
  const res = spawnSync("git", ["-C", root, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8", timeout: 15_000 });
  if (res.error || res.status !== 0 || !res.stdout) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
};

export const impact = (root: string, args: ImpactArgs): OpResult => {
  const state = ensureState(root);
  const g = state.graph;
  const B = clampBudget(args.budget, 2000);
  const files = new Set<string>(args.files ?? []);
  if (args.base) for (const f of prFiles(root, args.base)) files.add(f);
  if (args.includeUncommitted !== false && !args.base) for (const f of uncommittedFiles(root)) files.add(f);

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
  const groups: GroupLine[] = [...anchorHits];
  for (const [f, mass] of fileAgg) {
    const top = (fileTop.get(f) ?? []).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => g.nodes[i]!.name).join(", ");
    groups.push({ label: f, mass, detail: top ? `top: ${top}` : "" });
  }
  const seedNames = seeds.slice(0, 5).map((i) => g.nodes[i]!.file).join(", ");
  const fit = revealGroups(groups, {
    header: `fovea impact · ${seeds.length} seed${seeds.length === 1 ? "" : "s"} (${seedNames}${seeds.length > 5 ? ", …" : ""}) · t=${t} · review order by warmth`,
    budget: B,
  });
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      seeds: seeds.length,
      warmed: groups.length,
      truncated: fit.truncated,
      // Structured form for consumers (turn-sync): warmed anchor ids + files,
      // no text re-parsing.
      warmedAnchors: anchorHits.map((h) => h.label.replace(/^⚑\s*/, "")),
      warmedFiles: groups.filter((grp) => !grp.label.startsWith("⚑")).map((grp) => grp.label),
    },
  };
};

// For tests and benches: token estimate passthrough.
export const estimateTokens = tokenEstimate;
