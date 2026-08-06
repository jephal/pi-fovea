// Feature anchors: where a feature touches the outside world. Anchors are
// extracted by a declarative rule pack (ast-grep patterns + metadata), so new
// frameworks are added as data. A route registration is the canonical anchor:
// one pattern shape covers express/koa (TS), gin/echo/chi (Go), flask/fastapi
// decorators (Python), and axum-style chains (Rust).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { groupByLang, patternRun, patternRunAll } from "./astgrep.js";
import { PATH_TOKEN_RE } from "./extract.js";
import { classifyLiteral, normalizeLiteral } from "./join.js";
import type { Anchor } from "./types.js";

export interface AnchorRule {
  id: string;
  langs: string[];
  pattern: string;
  methods: string; // regex tested against the captured method metavar
  kind: string;
  /**
   * Optional class-level prefix patterns (e.g. NestJS '@Controller("api/x")').
   * Their $P captures are collected per file; a matched route path is composed
   * prefix + suffix so the anchor id is the full router-visible path.
   */
  prefixPattern?: string[];
}

const PLACEHOLDER_ONLY = /^(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/;

export const DEFAULT_PACK: AnchorRule[] = [
  {
    id: "http-route-call",
    langs: ["TypeScript", "Tsx", "JavaScript", "Go"],
    pattern: '$R.$M("$P", $$$H)',
    methods: "^(?i:get|post|put|delete|patch|head|options|all|use|any|handle|handlefunc|route|group)$",
    kind: "route",
  },
  {
    // Single-arg verb call: axios.get("/me") — client call sites only become
    // feature hubs when they reference a real path (validated below).
    id: "http-verb-single-arg",
    langs: ["TypeScript", "Tsx", "JavaScript"],
    pattern: '$R.$M("$P")',
    methods: "^(?i:get|post|put|delete|patch)$",
    kind: "route",
  },
  {
    id: "http-route-call-singlequote",
    langs: ["TypeScript", "Tsx", "JavaScript"],
    pattern: "$R.$M('$P', $$$H)",
    methods: "^(?i:get|post|put|delete|patch|all|use|handle|route)$",
    kind: "route",
  },
  {
    // NestJS / decorator shape: @Get("/users/:id") on a controller method.
    id: "ts-http-decorator",
    langs: ["TypeScript", "Tsx"],
    pattern: '@$M("$P")',
    methods: "^(?i:get|post|put|delete|patch|options|head)$",
    kind: "route",
    prefixPattern: ['@Controller("$P")', "@Controller('$P')"],
  },
  {
    // Single-quotes dominate real NestJS codebases (NOMAD, starters, docs).
    id: "ts-http-decorator-singlequote",
    langs: ["TypeScript", "Tsx"],
    pattern: "@$M('$P')",
    methods: "^(?i:get|post|put|delete|patch|options|head)$",
    kind: "route",
    prefixPattern: ['@Controller("$P")', "@Controller('$P')"],
  },
  {
    id: "python-decorator-route",
    langs: ["Python"],
    pattern: '@$R.$M("$P")',
    methods: "^(get|post|put|delete|patch|route|websocket)$",
    kind: "route",
  },
  {
    id: "python-decorator-route-singlequote",
    langs: ["Python"],
    pattern: "@$R.$M('$P')",
    methods: "^(get|post|put|delete|patch|route|websocket)$",
    kind: "route",
  },
  {
    id: "flask-add-url-rule",
    langs: ["Python"],
    pattern: '$R.add_url_rule("$P", $$$H)',
    methods: "^add_url_rule$",
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

// NestJS mounts every controller at the router root, so the joined path is
// always slash-rooted regardless of how each framework writes the pieces.
const joinRoute = (prefix: string, child: string): string => {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const c = child.replace(/^\/+|\/+$/g, "");
  return c ? `/${[p, c].filter(Boolean).join("/")}` : `/${p}`;
};

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
      const prefixes = new Map<string, string>(); // file -> @Controller prefix
      if (rule.prefixPattern?.length) {
        for (const pm of patternRunAll(rule.prefixPattern, lang, langFiles, cwd)) {
          const p = pm.single.P?.trim();
          if (p !== undefined && !prefixes.has(pm.file)) prefixes.set(pm.file, p);
        }
      }
      for (const m of patternRun(rule.pattern, lang, langFiles, cwd)) {
        const method = m.single.M;
        const path = m.single.P;
        if (!method || !path || !methodRe.test(method)) continue;
        const prefix = prefixes.get(m.file);
        const raw = prefix !== undefined && prefix !== "" ? joinRoute(prefix, path.trim()) : path.trim();
        // $R.$M(...) also matches Map.get("key")-style data access; only real
        // paths (or router-relative placeholders like ":id") may anchor.
        if (!PATH_TOKEN_RE.test(raw) && !PLACEHOLDER_ONLY.test(raw)) continue;
        const norm = normalizeLiteral(raw, "path");
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

// Repo-local overrides: .fovea/rules.json = { "rules": AnchorRule[] }.
// Merged after the default pack; the content hash invalidates the fact cache
// so changing rules rebuilds anchors only.
export const loadRepoRules = (root: string): { pack: AnchorRule[]; sha: string } => {
  let raw = "";
  try {
    raw = readFileSync(joinPath(root, ".fovea", "rules.json"), "utf8");
  } catch {
    return { pack: DEFAULT_PACK, sha: "" };
  }
  try {
    const parsed = JSON.parse(raw) as { rules?: AnchorRule[] };
    const rules = (parsed.rules ?? []).filter(
      (r) => r && typeof r.pattern === "string" && typeof r.methods === "string" && Array.isArray(r.langs),
    );
    return { pack: [...DEFAULT_PACK, ...rules], sha: createHash("sha1").update(raw).digest("hex") };
  } catch {
    return { pack: DEFAULT_PACK, sha: createHash("sha1").update(raw).digest("hex") };
  }
};
