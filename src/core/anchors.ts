// Feature anchors: where a feature touches the outside world. Anchors are
// extracted by a declarative rule pack (ast-grep patterns + metadata), so new
// frameworks are added as data. A route registration is the canonical anchor:
// one pattern shape covers express/koa (TS), gin/echo/chi (Go), flask/fastapi
// decorators (Python), and axum-style chains (Rust).

import { groupByLang, patternRun } from "./astgrep.js";
import { classifyLiteral, normalizeLiteral } from "./join.js";
import type { Anchor } from "./types.js";

export interface AnchorRule {
  id: string;
  langs: string[];
  pattern: string;
  methods: string; // regex tested against the captured method metavar
  kind: string;
}

export const DEFAULT_PACK: AnchorRule[] = [
  {
    id: "http-route-call",
    langs: ["TypeScript", "Tsx", "JavaScript", "Go"],
    pattern: '$R.$M("$P", $$$H)',
    methods: "^(?i:get|post|put|delete|patch|head|options|all|use|any)$",
    kind: "route",
  },
  {
    id: "http-route-call-singlequote",
    langs: ["TypeScript", "Tsx", "JavaScript"],
    pattern: "$R.$M('$P', $$$H)",
    methods: "^(get|post|put|delete|patch|all|use)$",
    kind: "route",
  },
  {
    id: "python-decorator-route",
    langs: ["Python"],
    pattern: '@$R.$M("$P")',
    methods: "^(get|post|put|delete|patch|route)$",
    kind: "route",
  },
  {
    id: "python-decorator-route-singlequote",
    langs: ["Python"],
    pattern: "@$R.$M('$P')",
    methods: "^(get|post|put|delete|patch|route)$",
    kind: "route",
  },
  {
    id: "rust-router-chain",
    langs: ["Rust"],
    pattern: '$R.route("$P", $$$H)',
    methods: "^route$",
    kind: "route",
  },
];

export interface AnchorDraft extends Anchor {}

export const extractAnchors = (
  files: string[],
  cwd: string,
  resolveEnclosing: (file: string, line: number) => string | undefined,
  pack: AnchorRule[] = DEFAULT_PACK,
): AnchorDraft[] => {
  const byLang = groupByLang(files);
  const out: AnchorDraft[] = [];
  for (const rule of pack) {
    const methodRe = new RegExp(rule.methods);
    for (const lang of rule.langs) {
      const langFiles = byLang.get(lang);
      if (!langFiles?.length) continue;
      for (const m of patternRun(rule.pattern, lang, langFiles, cwd)) {
        const method = m.single.M;
        const path = m.single.P;
        if (!method || !path || !methodRe.test(method)) continue;
        const norm = normalizeLiteral(path, "path");
        const httpMethod = method.toUpperCase() === "ROUTE" || method.toLowerCase() === "route" || method.toLowerCase() === "use" || method.toLowerCase() === "any"
          ? method.toUpperCase()
          : method.toUpperCase();
        const label = `${httpMethod} ${norm}`;
        const enclosing = resolveEnclosing(m.file, m.line);
        out.push({
          id: label,
          kind: rule.kind,
          label,
          nodeId: enclosing ?? `file:${m.file}`,
          file: m.file,
          line: m.line,
        });
      }
    }
  }
  // Dedupe identical anchors at the same site (overlapping rules).
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.id}|${a.file}|${a.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Re-export so callers can classify an anchor path like any literal.
export const anchorClassify = classifyLiteral;
