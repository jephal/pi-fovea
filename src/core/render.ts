// The foveated renderer. The diffusion field assigns every node a heat;
// heat relative to the focus maximum sets the acuity tier (hot = full
// signature, warm = one-line mention, glow = collapsed per-file count).
// Budget conformance is a prefix fit: candidates sorted by heat, binary search
// on prefix length — aider's render-and-count loop generalized to a field.

import type { Edge, EdgeKind, Graph, NodeRec } from "./types.js";

export const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);

export const HOT_TIER = 0.3;
export const WARM_TIER = 0.02;
export const HEAT_EPS = 1e-9;
export const MAX_UNRELATED_WARM_PER_FILE = 4;

export const formatNodeLocation = (node: NodeRec): string => {
  if (node.kind === "file" || node.line <= 0) return node.file;
  if (node.lineApproximate) return `${node.file} (member line unavailable)`;
  return `${node.file}:${node.line}`;
};

interface DirectRelation {
  kind: EdgeKind;
  label: string;
  priority: number;
  weight: number;
  seed: number;
}

const RELATION_PRIORITY: Record<EdgeKind, number> = {
  contains: 0,
  cochange: 1,
  imports: 2,
  join: 3,
  anchors: 4,
  tests: 5,
  inherits: 6,
  invokes: 7,
};

const relationLabel = (edge: Edge, seedAtA: boolean, candidate: NodeRec): string => {
  switch (edge.kind) {
    case "invokes": return seedAtA ? "→ callee" : "← caller";
    case "imports": return seedAtA ? "→ import" : "← importer";
    case "tests": return seedAtA ? "→ subject" : "← test";
    case "inherits": return seedAtA ? "→ parent" : "← subclass";
    case "anchors": return seedAtA ? candidate.kind === "file" ? "→ feature file" : "→ handler" : "← route";
    case "join": return "↔ shared literal";
    case "cochange": return "↔ co-change";
    case "contains": return seedAtA ? "◇ member" : "◇ file";
  }
};

const directRelations = (g: Graph, seeds: ReadonlySet<number>): Map<number, DirectRelation> => {
  const out = new Map<number, DirectRelation>();
  for (const edge of g.edges) {
    const aSeed = seeds.has(edge.a);
    const bSeed = seeds.has(edge.b);
    if (aSeed === bSeed) continue;
    const node = aSeed ? edge.b : edge.a;
    const relation: DirectRelation = {
      kind: edge.kind,
      label: relationLabel(edge, aSeed, g.nodes[node]!),
      priority: RELATION_PRIORITY[edge.kind],
      weight: edge.w,
      seed: aSeed ? edge.a : edge.b,
    };
    const current = out.get(node);
    if (!current || relation.priority > current.priority ||
      (relation.priority === current.priority && relation.weight > current.weight)) {
      out.set(node, relation);
    }
  }
  return out;
};

export interface RevealedNode {
  id: string;
  name: string;
  kind: NodeRec["kind"];
  language: string;
  file: string;
  line: number;
  lineApproximate?: boolean;
  signature: string;
  role: "focus" | "direct" | "hot" | "warm";
  relation?: string;
  seedId?: string;
}

export interface FitResult {
  text: string;
  tokens: number;
  shown: number;      // individually rendered nodes
  suppressed: number; // skipped because already disclosed
  litTotal: number;   // candidates above threshold before suppression
  truncated: boolean;
}

const cmpNodes = (g: Graph, field: Float64Array) => (x: number, y: number): number => {
  const f = field[y]! - field[x]!;
  if (f !== 0) return f;
  const a = g.nodes[x]!;
  const b = g.nodes[y]!;
  return a.file === b.file ? (a.line - b.line || a.name.localeCompare(b.name)) : a.file < b.file ? -1 : 1;
};

export interface RevealOptions {
  header?: string;
  disclosed?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>; // hard exclusion (e.g. seeds for impact)
  include?: ReadonlySet<string>; // optional focus scope
  seeds?: readonly number[];
  repeatNucleus?: boolean;
  budget: number;
  maxCandidates?: number;
}

export const revealFoveated = (
  g: Graph,
  field: Float64Array,
  opts: RevealOptions,
): FitResult & { revealedIds: string[]; revealed: RevealedNode[] } => {
  let vmax = 0;
  for (let i = 0; i < field.length; i++) if (field[i]! > vmax) vmax = field[i]!;
  if (vmax <= 0) {
    return { text: `${opts.header ?? "fovea"}\n(nothing matched the current graph)`, tokens: 0, shown: 0, suppressed: 0, litTotal: 0, truncated: false, revealedIds: [], revealed: [] };
  }
  const seedSet = new Set(opts.seeds ?? []);
  const relations = directRelations(g, seedSet);
  const candidates: number[] = [];
  let suppressed = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    const h = field[i]! / vmax;
    const direct = relations.get(i);
    if ((!direct || direct.kind === "contains") && (h < WARM_TIER * 0.1 || field[i]! < HEAT_EPS)) continue;
    const id = g.nodes[i]!.id;
    if (opts.include && !opts.include.has(id)) continue;
    if (opts.exclude?.has(id)) continue;
    const inNucleus = seedSet.has(i) || (direct !== undefined && direct.kind !== "contains");
    if (opts.disclosed?.has(id) && !(opts.repeatNucleus && inNucleus)) { suppressed++; continue; }
    candidates.push(i);
  }
  const byHeat = cmpNodes(g, field);
  candidates.sort((a, b) => {
    const aPriority = seedSet.has(a) ? 2 : relations.get(a)?.kind === "contains" ? 0 : relations.has(a) ? 1 : 0;
    const bPriority = seedSet.has(b) ? 2 : relations.get(b)?.kind === "contains" ? 0 : relations.has(b) ? 1 : 0;
    return bPriority - aPriority || byHeat(a, b);
  });
  const cap = opts.maxCandidates ?? 400;
  const capped = candidates.slice(0, cap);
  const litTotal = capped.length;

  // Individual lines first (hot signatures, warm one-liners), then the cheap
  // glow periphery collapsed per file. The prefix is over BOTH lists so the
  // budget can shrink the periphery too; appending is byte-monotone, hence the
  // binary search is exact and the output can never exceed the budget.
  const glowCounts = new Map<string, number>();
  const warmPerFile = new Map<string, number>();
  const lines: string[] = [];
  const ids: string[] = [];
  const revealed: RevealedNode[] = [];
  for (const i of capped) {
    const node = g.nodes[i]!;
    const h = field[i]! / vmax;
    const relation = relations.get(i);
    const semanticRelation = relation && relation.kind !== "contains" ? relation : undefined;
    const displayRelation = relation
      ? seedSet.size > 1
        ? `${relation.label} of ${g.nodes[relation.seed]!.name}`
        : relation.label
      : undefined;
    const context = seedSet.has(i) ? "  [focus]" : displayRelation ? `  [${displayRelation}]` : "";
    const remember = (role: RevealedNode["role"]): void => {
      ids.push(node.id);
      revealed.push({
        id: node.id,
        name: node.name,
        kind: node.kind,
        language: node.lang,
        file: node.file,
        line: node.line,
        lineApproximate: node.lineApproximate,
        signature: node.sig,
        role,
        relation: displayRelation,
        seedId: relation ? g.nodes[relation.seed]!.id : undefined,
      });
    };
    if (h >= HOT_TIER || seedSet.has(i)) {
      lines.push(
        node.kind === "file"
          ? `▒ ${node.file}${context}`
          : node.kind === "anchor"
            ? `⚑ ${node.sig}${context}`
            : `▲ ${formatNodeLocation(node)}  ${node.sig}${context}`,
      );
      remember(seedSet.has(i) ? "focus" : semanticRelation ? "direct" : "hot");
    } else if (h >= WARM_TIER || semanticRelation) {
      const warmCount = warmPerFile.get(node.file) ?? 0;
      if (!semanticRelation && node.kind !== "file" && warmCount >= MAX_UNRELATED_WARM_PER_FILE) {
        glowCounts.set(node.file, (glowCounts.get(node.file) ?? 0) + 1);
        continue;
      }
      if (!semanticRelation && node.kind !== "file") warmPerFile.set(node.file, warmCount + 1);
      lines.push(
        semanticRelation
          ? `  ${displayRelation}  ${node.name} (${node.kind}) ${formatNodeLocation(node)}`
          : `  · ${node.name} (${node.kind}) ${formatNodeLocation(node)}`,
      );
      remember(semanticRelation ? "direct" : "warm");
    } else {
      glowCounts.set(node.file, (glowCounts.get(node.file) ?? 0) + 1);
    }
  }
  const glowLines = [...glowCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file, c]) => `  ~ +${c} more in ${file}`);
  const items = [...lines, ...glowLines];
  const individual = lines.length;

  const header = `${opts.header ?? "fovea"}${suppressed ? ` · ${suppressed} prior results omitted` : ""}`;
  const collapsed = litTotal - individual;
  const renderK = (k: number): string => {
    const shownIndiv = Math.min(k, individual);
    const remaining = collapsed + individual - shownIndiv;
    const footer = remaining > 0
      ? `\n… ${remaining} more results collapsed or outside budget — use fovea_dwell for wider context`
      : "";
    return header + "\n" + items.slice(0, k).join("\n") + footer;
  };

  const fits = (k: number): boolean => tokenEstimate(renderK(k)) <= opts.budget;
  let k = items.length;
  if (!fits(k)) {
    let lo = 0;
    let hi = items.length - 1;
    k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!fits(0)) k = -1; // extreme budgets: header + footer only
  }
  const text = k >= 0 ? renderK(k) : header;
  const tokens = tokenEstimate(text);
  const shown = k >= 0 ? Math.min(k, individual) : 0;
  return {
    text,
    tokens,
    shown,
    suppressed,
    litTotal,
    truncated: shown < individual || (k >= 0 && k < items.length),
    revealedIds: ids.slice(0, shown),
    revealed: revealed.slice(0, shown),
  };
};

// Grouped reveal for sketch and impact, one line per group.

export interface GroupLine { label: string; mass: number; detail: string; }

export const revealGroups = (
  groups: GroupLine[],
  opts: { header: string; budget: number },
): FitResult => {
  const ordered = [...groups].sort((a, b) => b.mass - a.mass || (a.label < b.label ? -1 : 1));
  const renderK = (k: number): string => {
    const body = ordered.slice(0, k).map((gl) => `${gl.label.padEnd(2)} ${gl.detail}`);
    const rest = ordered.length - k;
    const footer = rest > 0 ? [`\n… ${rest} more groups omitted — use fovea_focus for detail`] : [];
    return [opts.header, ...body, ...footer].join("\n");
  };
  let hi = ordered.length;
  let best = renderK(hi);
  if (tokenEstimate(best) > opts.budget) {
    let lo = 0;
    best = renderK(0);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const text = renderK(mid);
      if (tokenEstimate(text) <= opts.budget) {
        best = text;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }
  return {
    text: best,
    tokens: tokenEstimate(best),
    shown: Math.min(ordered.length, ordered.length),
    suppressed: 0,
    litTotal: ordered.length,
    truncated: ordered.length > 0 && best.split("\n").some((l) => l.startsWith("…")),
  };
};
