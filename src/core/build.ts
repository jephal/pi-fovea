// Repo -> typed graph. Extraction is a pure function of file content, so the
// on-disk cache (keyed by content sha1) makes re-indexing incremental: dirty
// files re-run ast-grep, everything else is reused verbatim. This is the
// green-node-reuse analogue of incremental parsing, one level up.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join as joinPath, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { LANG_BY_EXT, isBinaryExt, isConfigFile, langOf } from "./astgrep.js";
import { extractCalls, extractImports, extractLiterals, extractSymbols, isTestFile } from "./extract.js";
import { buildJoinIndex } from "./join.js";
import { extractAnchors, extractFileRoutes, loadRepoRules } from "./anchors.js";
import { aggregateFiles, harvestFile, promote, type FileSigs, type SynthesizedRule } from "./discover.js";
import type { CallSite, Edge, Graph, ImportSite, LiteralSite, NodeRec, SymbolRec } from "./types.js";
import type { AnchorDraft } from "./anchors.js";
import { coChangePairs } from "./cochange.js";

export interface FileFacts {
  sha1: string;
  symbols: SymbolRec[];
  imports: ImportSite[];
  calls: CallSite[];
  literals: LiteralSite[];
  anchors: AnchorDraft[];
  // Tier-3 discovery: per-file histogram of call-shape signatures
  // (sig -> [totalSites, pathSites]); aggregated repo-wide at load to promote
  // statistically significant unknown shapes into implicit half-weight rules.
  sigs?: FileSigs;
}

const CACHE_VERSION = 7; // bump when extractor semantics change
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "vendor", ".venv", "venv", "target", "coverage", ".next", "build", "__pycache__", ".pi", ".pi-fovea", "deps", "_build", ".tox", "Pods"]);
const MAX_FILES = 24000;
// Generated dependency manifests are enormous and carry no first-class routes.
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "pipfile.lock", "poetry.lock", "cargo.lock", "composer.lock", "gemfile.lock", "go.sum",
]);

const isJunk = (f: string): boolean => {
  const segs = f.split("/");
  for (const s of segs) if (IGNORE_DIRS.has(s)) return true;
  const base = segs[segs.length - 1]!.toLowerCase();
  return LOCKFILE_NAMES.has(base) || base.endsWith(".lock");
};

const supported = (f: string, routeRes?: RegExp[]): boolean => {
  const ext = f.split(".").pop()?.toLowerCase() ?? "";
  if (!isBinaryExt(f) && (ext in LANG_BY_EXT || isConfigFile(f))) return true;
  // File-convention routers use extensions with no ast-grep lang (.svelte, .mdx).
  return routeRes?.some((re) => re.test(f)) ?? false;
};

export const listFiles = (root: string, routeRes?: RegExp[]): string[] => {
  const res = spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let files: string[] = [];
  if (!res.error && res.status === 0 && res.stdout.trim()) {
    files = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } else {
    const walk = (dir: string, prefix: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.has(e.name)) walk(joinPath(dir, e.name), rel);
        } else if (e.isFile() && supported(rel, routeRes)) {
          files.push(rel);
        }
      }
    };
    walk(root, "");
  }
  files = files.filter((f) => supported(f, routeRes) && !isJunk(f));
  files.sort();
  return files.slice(0, MAX_FILES);
};

const sha1Of = (root: string, rel: string): string => {
  try {
    const buf = readFileSync(joinPath(root, rel));
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return "!" + rel;
  }
};

interface CacheFile { version: number; root: string; rulesSha: string; facts: Record<string, FileFacts>; }

export const cachePathFor = (root: string): string =>
  joinPath(tmpdir(), `pi-fovea-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

export const loadFacts = (root: string, files: string[]): Record<string, FileFacts> => {
  const cacheFile = cachePathFor(root);
  let cached: CacheFile | undefined;
  try {
    cached = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheFile;
  } catch {
    cached = undefined;
  }
  const { pack: basePack, fileRoutes, sha: baseRulesSha } = loadRepoRules(root);
  const anchorPack = [...basePack];
  // Implicit rules promote AFTER the first fact pass: their evidence lives in
  // freshly harvested sigs, so the pack can only be finalized once facts exist.
  let implicitRules: SynthesizedRule[] = [];
  let rulesSha = baseRulesSha;
  if (cached && (cached.version !== CACHE_VERSION || cached.root !== root)) cached = undefined;
  const facts: Record<string, FileFacts> = {};
  const dirty: string[] = [];
  for (const rel of files) {
    const sha1 = sha1Of(root, rel);
    const hit = cached?.facts[rel];
    if (hit && hit.sha1 === sha1) {
      facts[rel] = hit;
    } else if (sha1.startsWith("!")) {
      continue; // unreadable; skip
    } else {
      dirty.push(rel);
      facts[rel] = { sha1, symbols: [], imports: [], calls: [], literals: [], anchors: [] };
    }
  }
  if (dirty.length) {
    const code = dirty.filter((f) => !isConfigFile(f));
    // Per-file buckets for batched extractor output.
    const putByFile = <T extends { file: string }>(arr: T[], sink: (f: FileFacts, v: T) => void): void => {
      for (const v of arr) {
        const f = facts[v.file];
        if (f) sink(f, v);
      }
    };
    putByFile(extractSymbols(code, root), (f, v) => f.symbols.push(v));
    putByFile(extractImports(code, root), (f, v) => f.imports.push(v));
    putByFile(extractCalls(code, root), (f, v) => f.calls.push(v));
    putByFile(extractLiterals(dirty, root), (f, v) => f.literals.push(v));
    // Tier-3 harvest: regex histogram of call-shape signatures per file. Cheap
    // (line scan, no ast-grep) and cached alongside the other facts.
    for (const f of code) {
      const lang = langOf(f);
      if (!lang) continue;
      let text = "";
      try { text = readFileSync(joinPath(root, f), "utf8"); } catch { continue; }
      const sigs = harvestFile(lang, text);
      if (Object.keys(sigs).length) facts[f]!.sigs = sigs;
    }
  }
  // Tier-3: promote harvested signatures into implicit rules BEFORE anchors
  // run, and fold their ids into the rules hash so a promotion change rebuilds
  // anchors exactly like a rules.json edit would.
  implicitRules = promote(aggregateFiles(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.sigs]))), anchorPack);
  if (implicitRules.length) {
    anchorPack.push(...implicitRules);
    rulesSha = createHash("sha1").update(baseRulesSha).update(JSON.stringify(implicitRules.map((r) => r.id).sort())).digest("hex");
  }
  const rulesChangedFinal = cached !== undefined && cached.rulesSha !== rulesSha;
  // Anchors need enclosing-symbol resolution. Symbols, imports, calls and
  // literals are rules-independent — when only the rule pack changed, re-run
  // anchor extraction over every code file against cached symbols and keep
  // every other fact (green-node reuse one level up).
  const anchorTargets = rulesChangedFinal
    ? files.filter((f) => !isConfigFile(f))
    : dirty.filter((f) => !isConfigFile(f));
  if (anchorTargets.length) {
    const putByFile = <T extends { file: string }>(arr: T[], sink: (f: FileFacts, v: T) => void): void => {
      for (const v of arr) {
        const f = facts[v.file];
        if (f) sink(f, v);
      }
    };
    const symsByFile = new Map<string, SymbolRec[]>();
    for (const rel of anchorTargets) {
      symsByFile.set(rel, facts[rel]?.symbols.length ? facts[rel]!.symbols : (cached?.facts[rel]?.symbols ?? []));
      if (rulesChangedFinal) facts[rel] && (facts[rel]!.anchors = []);
    }
    const enclosingId = (file: string, line: number): string | undefined => {
      const syms = symsByFile.get(file) ?? [];
      let best: SymbolRec | undefined;
      for (const s of syms) if (s.line <= line && (!best || s.line > best.line)) best = s;
      return best ? `${best.name}@${best.file}` : `file:${file}`;
    };
    putByFile(extractAnchors(anchorTargets, root, enclosingId, anchorPack), (f, v) => f.anchors.push(v));
    // File-convention routes (Next/SvelteKit/Nuxt): the route path is derived
    // from the file path; verbs come from exported handler names or suffix.
    putByFile(extractFileRoutes(anchorTargets, root, fileRoutes), (f, v) => f.anchors.push(v));
  }
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, root, rulesSha, facts } satisfies CacheFile));
  } catch {
    // Cache is an optimization; never fail the build over it.
  }
  return facts;
};

// --- resolution ---------------------------------------------------------------

const CODE_EXTS_BY_LANGFAMILY: Record<string, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  py: [".py"],
  rs: [".rs"],
  go: [],
};

const langFamily = (file: string): string => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (ext === "py") return "py";
  if (ext === "rs") return "rs";
  if (ext === "go") return "go";
  return ext;
};

export const resolveImportToFile = (
  spec: string,
  fromFile: string,
  fileSet: Set<string>,
  dirSet: Set<string>,
): string | undefined => {
  const fam = langFamily(fromFile);
  if (spec.startsWith("./") || spec.startsWith("../")) {
    let base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    // NodeNext convention: TS files import "./sibling.js" — the .js refers to
    // the .ts source. Strip a runtime extension before probing.
    base = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const ext of CODE_EXTS_BY_LANGFAMILY[fam] ?? []) {
      if (fileSet.has(base + ext)) return base + ext;
      if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
    if (fileSet.has(base)) return base;
    return undefined;
  }
  if (fam === "py") {
    const p = spec.replace(/\./g, "/");
    for (const cand of [`${p}.py`, `${p}/__init__.py`]) if (fileSet.has(cand)) return cand;
    return undefined;
  }
  if (fam === "go") {
    const segs = spec.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(3, segs.length); k++) {
      const suffix = segs.slice(-k).join("/");
      const matches = [...dirSet].filter((d) => d === suffix || d.endsWith(`/${suffix}`));
      if (matches.length === 1) {
        const dir = matches[0]!;
        for (const f of fileSet) if (posix.dirname(f) === dir) return f;
      }
    }
    return undefined;
  }
  if (fam === "rs") {
    const modPath = spec.replace(/^crate::|^self::/, "").replace(/::/g, "/");
    for (const cand of [`src/${modPath}.rs`, `${modPath}.rs`]) if (fileSet.has(cand)) return cand;
    const baseName = basename(modPath);
    const hits = [...fileSet].filter((f) => f === `${baseName}.rs` || f.endsWith(`/${baseName}.rs`) || f.endsWith(`/${baseName}/mod.rs`));
    return hits.length === 1 ? hits[0] : undefined;
  }
  // ts bare specifier: node_modules or aliased; try a tail match.
  const tail = spec.split("/").filter(Boolean).join("/");
  const hits = [...fileSet].filter((f) => f.endsWith(`/${tail}.ts`) || f.endsWith(`/${tail}/index.ts`));
  return hits.length === 1 ? hits[0] : undefined;
};

// --- assembly ------------------------------------------------------------------

const addNode = (nodes: NodeRec[], seen: Map<string, number>, rec: NodeRec): number => {
  const hit = seen.get(rec.id);
  if (hit !== undefined) return hit;
  const idx = nodes.length;
  seen.set(rec.id, idx);
  nodes.push(rec);
  return idx;
};

export const assembleGraph = (root: string, files: string[], facts: Record<string, FileFacts>): Graph => {
  void root;
  const nodes: NodeRec[] = [];
  const seen = new Map<string, number>();
  const edges: Edge[] = [];
  const byFile = new Map<string, number[]>();
  const fileIdx = new Map<string, number>();

  const pushEdge = (a: number, b: number, kind: Edge["kind"], w: number): void => {
    if (a === b) return;
    edges.push({ a, b, kind, w });
  };

  // File nodes first (stable for enclosing fallback + sketch grouping).
  for (const rel of files) {
    const idx = addNode(nodes, seen, {
      id: `file:${rel}`, name: posix.basename(rel), kind: "file", file: rel, line: 0,
      sig: rel, lang: LANG_BY_EXT[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "config",
    });
    fileIdx.set(rel, idx);
    (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
  }

  // Symbol nodes + contains edges.
  const symIdxByFileLine = new Map<string, number>(); // `${file}:${line}` first symbol idx
  for (const rel of files) {
    const f = facts[rel];
    if (!f) continue;
    for (const s of f.symbols) {
      const idx = addNode(nodes, seen, { id: `${s.name}@${s.file}`, ...s });
      (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
      pushEdge(fileIdx.get(rel)!, idx, "contains", 1.0);
      const key = `${rel}:${s.line}`;
      if (!symIdxByFileLine.has(key)) symIdxByFileLine.set(key, idx);
    }
  }

  // Order each file's node list by line for enclosing-symbol queries.
  for (const [, arr] of byFile) arr.sort((x, y) => nodes[x]!.line - nodes[y]!.line);

  const enclosingIdx = (file: string, line: number): number => {
    const arr = byFile.get(file) ?? [];
    let best = fileIdx.get(file)!;
    for (const idx of arr) {
      const n = nodes[idx]!;
      if (n.kind !== "file" && n.line <= line && nodes[best]!.line <= n.line) best = idx;
    }
    return best;
  };

  // byName index: exact, lowercased, and short suffix (methods).
  const byName = new Map<string, number[]>();
  {
    const addKey = (key: string, idx: number): void => {
      if (!key) return;
      (byName.get(key) ?? byName.set(key, []).get(key)!).push(idx);
    };
    nodes.forEach((n, i) => {
      if (n.kind === "file" || n.kind === "anchor") return;
      addKey(n.name.toLowerCase(), i);
      const dot = n.name.indexOf(".");
      if (dot > 0) addKey(n.name.slice(dot + 1).toLowerCase(), i);
    });
  }

  const fileSet = new Set(files);
  const dirSet = new Set(files.map((f) => posix.dirname(f)));

  // Import edges (file-level, low conductance backbone) + tests wiring.
  const importTargets = new Map<string, string[]>();
  for (const rel of files) {
    const f = facts[rel];
    if (!f) continue;
    for (const imp of f.imports) {
      const target = resolveImportToFile(imp.spec, rel, fileSet, dirSet);
      if (!target || target === rel) continue;
      pushEdge(fileIdx.get(rel)!, fileIdx.get(target)!, "imports", 0.3);
      (importTargets.get(rel) ?? importTargets.set(rel, []).get(rel)!).push(target);
    }
    if (isTestFile(rel)) {
      for (const t of importTargets.get(rel) ?? []) {
        pushEdge(fileIdx.get(rel)!, fileIdx.get(t)!, "tests", 0.6);
      }
    }
  }

  // Call edges: resolve callee by name, prefer same-file, then imported files,
  // then a globally unique definition. Conductance decays with definition
  // cardinality: a name defined twice is a pointer, a name defined 40 times
  // is ambient noise (the dynamic-language `str(`/`it(` hub failure mode).
  for (const rel of files) {
    const f = facts[rel];
    if (!f) continue;
    const imported = new Set(importTargets.get(rel) ?? []);
    for (const call of f.calls) {
      const cands = byName.get(call.callee.toLowerCase()) ?? [];
      if (!cands.length || cands.length > 48) continue;
      let chosen: number[] = cands.filter((i) => nodes[i]!.file === rel);
      if (!chosen.length) chosen = cands.filter((i) => imported.has(nodes[i]!.file));
      if (!chosen.length && cands.length === 1) chosen = cands;
      if (!chosen.length || chosen.length > 3) continue;
      const w = cands.length <= 8 ? 0.7 : cands.length <= 24 ? 0.45 : 0.25;
      const from = enclosingIdx(rel, call.line);
      for (const to of chosen) pushEdge(from, to, "invokes", w);
    }
  }

  // Inherits edges from class signatures (TS/py style visible on the sig line).
  nodes.forEach((n, i) => {
    if (n.kind !== "class") return;
    for (const m of n.sig.matchAll(/extends\s+([A-Za-z_$][\w$.]*)/g)) {
      for (const to of byName.get(m[1]!.toLowerCase()) ?? []) pushEdge(i, to, "inherits", 0.9);
    }
    const impl = /implements\s+([A-Za-z_$][\w$.,\s]*)/.exec(n.sig);
    if (impl) {
      for (const raw of impl[1]!.split(",")) {
        for (const to of byName.get(raw.trim().toLowerCase()) ?? []) pushEdge(i, to, "inherits", 0.9);
      }
    }
  });

  // Literal join edges (the cross-language bridge).
  const allSites: LiteralSite[] = [];
  for (const rel of files) for (const l of facts[rel]?.literals ?? []) allSites.push(l);
  const joinIdx = buildJoinIndex(allSites, (file, line) => enclosingIdx(file, line));
  for (const je of joinIdx.edges) pushEdge(je.a, je.b, "join", je.w);

  // Anchors: ONE node per feature route, not per site. Server registration
  // and every client call of "POST /auth/login" are occurrences of the same
  // feature; the anchor hub is where they meet. Site conductance decays with
  // sqrt(count) so a route consumed everywhere doesn't become a gravity well.
  const drafts = files.flatMap((rel) => facts[rel]?.anchors ?? []);
  const draftsByLabel = new Map<string, AnchorDraft[]>();
  for (const a of drafts) {
    (draftsByLabel.get(a.id) ?? draftsByLabel.set(a.id, []).get(a.id)!).push(a);
  }
  const anchors: Graph["anchors"] = [];
  for (const [label, sites] of draftsByLabel) {
    const first = sites[0]!;
    const filesOf = [...new Set(sites.map((s) => s.file))];
    // A hub is implicit only when EVERY site came from a discovered rule — a
    // match by any real rule upgrades it back to first-class instantly.
    const hubImplicit = sites.every((s) => s.implicit === true);
    anchors.push({ id: label, kind: first.kind, label: sites.length > 1 ? `${label} · ${sites.length} sites` : label, nodeId: first.nodeId, file: first.file, line: first.line, ...(hubImplicit ? { implicit: true } : {}) });
    const idx = addNode(nodes, seen, {
      id: `anchor:${label}`, name: label, kind: "anchor", file: first.file, line: first.line,
      sig: `${hubImplicit ? "(△ discovered) " : ""}${sites.length > 1 ? `${label} (${sites.length} sites)` : label}`, lang: "anchor",
    });
    (byFile.get(first.file) ?? byFile.set(first.file, []).get(first.file)!).push(idx);
    // Tier-3 hubs prove themselves at half conductance; a later literal join
    // against a first-class hub can still warm them via the channel edges.
    const w = (hubImplicit ? 0.5 : 1) / Math.sqrt(sites.length);
    for (const s of sites) {
      const handler = seen.get(s.nodeId) ?? fileIdx.get(s.file)!;
      pushEdge(idx, handler, "anchors", w);
    }
    // A multi-file route binds its files too (the feature's file hood).
    if (filesOf.length > 1 && filesOf.length <= 12) {
      const fw = 0.35 / Math.sqrt(filesOf.length);
      for (const f of filesOf) pushEdge(idx, fileIdx.get(f)!, "anchors", fw);
    }
  }

  // Co-change conductance from git history (bounded, HEAD-keyed, separately
  // cached). Files that commute together belong together even without a
  // static edge; reviewer-relevant warmth flows here.
  for (const [fa, fb, w] of coChangePairs(root, files)) {
    const ia = fileIdx.get(fa);
    const ib = fileIdx.get(fb);
    if (ia !== undefined && ib !== undefined) pushEdge(ia, ib, "cochange", w);
  }

  return { nodes, edges, byName, byFile, anchors, files };
};
