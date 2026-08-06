// The foveated renderer. The diffusion field assigns every node a heat;
// heat relative to the focus maximum sets the acuity tier (hot = full
// signature, warm = one-line mention, glow = collapsed per-file count).
// Budget conformance is a prefix fit: candidates sorted by heat, binary search
// on prefix length — aider's render-and-count loop generalized to a field.

import type { Graph } from "./types.js";

export const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);

export const HOT_TIER = 0.3;
export const WARM_TIER = 0.02;
export const HEAT_EPS = 1e-9;

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
  budget: number;
  maxCandidates?: number;
}

export const revealFoveated = (
  g: Graph,
  field: Float64Array,
  opts: RevealOptions,
): FitResult & { revealedIds: string[] } => {
  let vmax = 0;
  for (let i = 0; i < field.length; i++) if (field[i]! > vmax) vmax = field[i]!;
  if (vmax <= 0) {
    return { text: `${opts.header ?? "fovea"}\n(nothing lit — field is zero)`, tokens: 0, shown: 0, suppressed: 0, litTotal: 0, truncated: false, revealedIds: [] };
  }
  const candidates: number[] = [];
  let suppressed = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    const h = field[i]! / vmax;
    if (h < WARM_TIER * 0.1 || field[i]! < HEAT_EPS) continue;
    const id = g.nodes[i]!.id;
    if (opts.exclude?.has(id)) continue;
    if (opts.disclosed?.has(id)) { suppressed++; continue; }
    candidates.push(i);
  }
  candidates.sort(cmpNodes(g, field));
  const cap = opts.maxCandidates ?? 400;
  const capped = candidates.slice(0, cap);
  const litTotal = capped.length;

  // Individual lines first (hot signatures, warm one-liners), then the cheap
  // glow periphery collapsed per file. The prefix is over BOTH lists so the
  // budget can shrink the periphery too; appending is byte-monotone, hence the
  // binary search is exact and the output can never exceed the budget.
  const glowCounts = new Map<string, number>();
  const lines: string[] = [];
  const ids: string[] = [];
  for (const i of capped) {
    const n = g.nodes[i]!;
    const h = field[i]! / vmax;
    if (h >= HOT_TIER) {
      lines.push(n.kind === "file" ? `▒ ${n.file}` : n.kind === "anchor" ? `⚑ ${n.sig}` : `▲ ${n.file}:${n.line}  ${n.sig}`);
      ids.push(n.id);
    } else if (h >= WARM_TIER) {
      lines.push(`  · ${n.name} (${n.kind}) ${n.file}:${n.line}`);
      ids.push(n.id);
    } else {
      glowCounts.set(n.file, (glowCounts.get(n.file) ?? 0) + 1);
    }
  }
  const glowLines = [...glowCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file, c]) => `  ~ +${c} more in ${file}`);
  const items = [...lines, ...glowLines];
  const individual = lines.length;

  const header = `${opts.header ?? "fovea"} · lit ${litTotal}${suppressed ? `, ${suppressed} seen` : ""}`;
  const renderK = (k: number): string => {
    const shownIndiv = Math.min(k, individual);
    const remaining = litTotal - shownIndiv;
    const footer = remaining > 0
      ? `\n… ${remaining} lit below threshold — call fovea_dwell to expand (t grows, periphery sharpens)`
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
  };
};

// --- grouped reveal (sketch / impact): one line per group ----------------------

export interface GroupLine { label: string; mass: number; detail: string; }

export const revealGroups = (
  groups: GroupLine[],
  opts: { header: string; budget: number },
): FitResult => {
  const ordered = [...groups].sort((a, b) => b.mass - a.mass || (a.label < b.label ? -1 : 1));
  const renderK = (k: number): string => {
    const body = ordered.slice(0, k).map((gl) => `${gl.label.padEnd(2)} ${gl.detail}`);
    const rest = ordered.length - k;
    const footer = rest > 0 ? [`\n… ${rest} groups below threshold — fovea_focus one for detail`] : [];
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
