// Per-file extraction: symbols (ast-grep outline), imports, calls, literals.
// Pure functions of file content where possible; each stage is separately
// cached by file content hash in build.ts, which is what makes re-indexing
// incremental (dirty files only).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupByLang,
  isConfigFile,
  outline,
  patternRunAll,
} from "./astgrep.js";
import type {
  CallSite,
  ImportSite,
  LiteralSite,
  NodeKind,
  SymbolRec,
} from "./types.js";

// --- symbols via `ast-grep outline` ----------------------------------------

type NamedSig = { name: string; kind: NodeKind };

const RX = (re: RegExp, kind: NodeKind, parentGroup?: number, nameGroup?: number) => ({ re, kind, parentGroup, nameGroup });
const SIG_RULES: Record<string, Array<{ re: RegExp; kind: NodeKind; parentGroup?: number; nameGroup?: number }>> = {
  TypeScript: [
    RX(/\bclass\s+([A-Za-z_$][\w$]*)/, "class"),
    RX(/\binterface\s+([A-Za-z_$][\w$]*)/, "interface"),
    RX(/\benum\s+([A-Za-z_$][\w$]*)/, "type"),
    RX(/\btype\s+([A-Za-z_$][\w$]*)/, "type"),
    RX(/\bfunction\s+([A-Za-z_$][\w$]*)/, "function"),
    RX(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "function"),
  ],
  JavaScript: [], // filled below (same as TypeScript)
  Tsx: [],
  Go: [
    RX(/^func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/, "method", 1, 2),
    RX(/^func\s+([A-Za-z_]\w*)/, "function"),
    RX(/^type\s+([A-Za-z_]\w*)\s+struct/, "class"),
    RX(/^type\s+([A-Za-z_]\w*)\s+interface/, "interface"),
    RX(/^type\s+([A-Za-z_]\w*)/, "type"),
  ],
  Python: [
    RX(/^\s*class\s+([A-Za-z_]\w*)/, "class"),
    RX(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"),
    RX(/^\s*([A-Za-z_]\w*)\s*=/, "decl"),
  ],
  Rust: [
    RX(/\bfn\s+([A-Za-z_]\w*)/, "function"),
    RX(/\bstruct\s+([A-Za-z_]\w*)/, "class"),
    RX(/\b(?:trait|enum|mod)\s+([A-Za-z_]\w*)/, "type"),
  ],
};
SIG_RULES.JavaScript = SIG_RULES.TypeScript!;
SIG_RULES.Tsx = SIG_RULES.TypeScript!;

const kindOf = (kind: string): NodeKind =>
  kind === "method" ? "method" : kind === "field" ? "field" : "decl";

const cleanSig = (line: string): string => {
  let s = line.trim();
  const brace = s.indexOf("{");
  if (brace > 0 && s.length > 140) s = s.slice(0, brace).trimEnd() + " { ... }";
  if (s.length > 140) s = s.slice(0, 137) + "...";
  return s;
};

export const deriveName = (sig: string, lang: string, parentHint?: string): NamedSig => {
  for (const r of SIG_RULES[lang] ?? []) {
    const m = r.re.exec(sig);
    if (!m) continue;
    if (r.parentGroup && m[r.parentGroup] && m[r.nameGroup ?? 1]) {
      return { name: `${m[r.parentGroup]}.${m[r.nameGroup ?? 1]}`, kind: r.kind };
    }
    if (m[1]) return { name: parentHint ? `${parentHint}.${m[1]}` : m[1], kind: r.kind };
  }
  const first = sig.trim().split(/[\s(:={]/)[0] ?? "?";
  return { name: first.replace(/^[*&]+/, "") || "?", kind: "decl" };
};

const parseOutlineText = (text: string, lang: string): SymbolRec[] => {
  const out: SymbolRec[] = [];
  let file = "";
  let top: SymbolRec | undefined;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const entry = /^\s*(\d+):\s(.*)$/.exec(raw);
    const child = /^(\s+)(method|field):\s(.+)$/.exec(raw);
    if (entry) {
      file = file || "";
      const sig = cleanSig(entry[2]!);
      if (!sig) continue;
      const named = deriveName(sig, lang);
      top = { name: named.name, kind: named.kind, file, line: Number(entry[1]), sig, lang };
      out.push(top);
      continue;
    }
    if (child && top) {
      for (const part of child[3]!.split(",")) {
        const name = part.trim();
        if (!name) continue;
        out.push({
          name: `${top.name}.${name}`,
          kind: kindOf(child[2]!),
          file,
          line: top.line, // outline children carry no line; point at parent
          sig: `${kindOf(child[2]!)} ${top.name}.${name}`,
          lang,
        });
      }
      continue;
    }
    // Otherwise: a file header line.
    file = raw.trim();
    top = undefined;
  }
  return out;
};

export const extractSymbols = (files: string[], cwd: string): SymbolRec[] => {
  const out: SymbolRec[] = [];
  for (const [lang, langFiles] of groupByLang(files)) {
    const text = outline(langFiles, lang, cwd);
    if (!text.trim()) continue;
    out.push(...parseOutlineText(text, lang));
  }
  return out.filter((s) => s.file);
};

// --- imports ------------------------------------------------------------------

const IMPORT_PATTERNS: Record<string, string[]> = {
  TypeScript: [
    'import $$$I from "$M"',
    "import $$$I from '$M'",
    'import "$M"',
    "import '$M'",
    'export $$$I from "$M"',
    "export $$$I from '$M'",
    'require("$M")',
  ],
  Go: ['import "$M"', 'import ( $$$S )'],
  Python: ["import $M", "from $M import $$$I"],
  Rust: ["use $M;"],
};
IMPORT_PATTERNS.JavaScript = IMPORT_PATTERNS.TypeScript!;
IMPORT_PATTERNS.Tsx = IMPORT_PATTERNS.TypeScript!;

export const extractImports = (files: string[], cwd: string): ImportSite[] => {
  const out: ImportSite[] = [];
  for (const [lang, langFiles] of groupByLang(files)) {
    const matches = patternRunAll(IMPORT_PATTERNS[lang] ?? [], lang, langFiles, cwd);
    for (const m of matches) {
      const spec = m.single.M;
      if (spec) {
        out.push({ file: m.file, spec, line: m.line });
        continue;
      }
      // Go import block: pull quoted specs out of the captured block text.
      for (const blockText of [m.text, ...(m.multi.S ?? [])]) {
        for (const sm of blockText.matchAll(/"([^"\n]+)"/g)) {
          out.push({ file: m.file, spec: sm[1]!, line: m.line });
        }
      }
    }
  }
  return dedupe(out, (i) => `${i.file}|${i.spec}|${i.line}`);
};

// --- calls -------------------------------------------------------------------

const CALL_PATTERNS = ["$O.$M($$$A)", "$F($$$A)"];

const isTestFile = (file: string): boolean =>
  /(^|\/)(test_|conftest)|\.(test|spec)\.[tj]sx?$|_test\.go$/.test(file);

export { isTestFile };

export const extractCalls = (files: string[], cwd: string): CallSite[] => {
  const out: CallSite[] = [];
  for (const [lang, langFiles] of groupByLang(files)) {
    const matches = patternRunAll(CALL_PATTERNS, lang, langFiles, cwd);
    for (const m of matches) {
      const callee = m.single.M ?? m.single.F;
      if (!callee) continue;
      out.push({ file: m.file, line: m.line, callee: callee.trim() });
    }
  }
  return out.filter((c) => c.callee && c.callee.length > 1);
};

// --- literals ------------------------------------------------------------------

const STRING_PATTERNS: Record<string, string[]> = {
  TypeScript: ['"$S"', "'$S'", "`$S`"],
  Go: ['"$S"', "`$S`"],
  Python: ['"$S"', "'$S'"],
  Rust: ['"$S"'],
};
STRING_PATTERNS.JavaScript = STRING_PATTERNS.TypeScript!;
STRING_PATTERNS.Tsx = STRING_PATTERNS.TypeScript!;

const QUOTED_RE = /"([^"\n]{2,200})"|'([^'\n]{2,200})'/g;
const TEMPLATE_RE = /`([^`\n]{2,200})`/g;
export const PATH_TOKEN_RE = /^(?:\/[\w.~+\-{}*:$]+\/?|\/?[\w.~+\-]+(?:\/[\w.~+\-{}*:$]+)+\/?)$/;
export const ENV_TOKEN_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// Config files can't be parsed as code; scan quoted strings plus bare
// path/env-shaped scalars so OpenAPI paths and k8s env keys still join.
const CONFIG_BARE_RE = /(^|[:=\s])(\/[\w.~+\-{}*]+(?:\/[\w.~+\-{}*]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=$|[:=\s])/g;

export const extractConfigLiterals = (files: string[], cwd: string): LiteralSite[] => {
  const out: LiteralSite[] = [];
  for (const f of files) {
    if (!isConfigFile(f)) continue;
    let text = "";
    try {
      text = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    const seenLine = new Set<string>();
    text.split("\n").forEach((lineText, i) => {
      QUOTED_RE.lastIndex = 0;
      for (let q; (q = QUOTED_RE.exec(lineText)); ) {
        const t = q[1] ?? q[2];
        if (t && !seenLine.has(`${i}|${t}`)) {
          seenLine.add(`${i}|${t}`);
          out.push({ file: f, line: i + 1, text: t });
        }
      }
      CONFIG_BARE_RE.lastIndex = 0;
      for (let b; (b = CONFIG_BARE_RE.exec(lineText)); ) {
        const t = b[2]!;
        if ((PATH_TOKEN_RE.test(t) || ENV_TOKEN_RE.test(t)) && !seenLine.has(`${i}|${t}`)) {
          seenLine.add(`${i}|${t}`);
          out.push({ file: f, line: i + 1, text: t });
        }
      }
    });
  }
  return out;
};

const stripQuotes = (text: string): string => {
  if (text.length >= 2) {
    const a = text[0]!;
    const b = text[text.length - 1]!;
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === "`" && b === "`")) {
      const inner = text.slice(1, -1).trim();
      return inner.length >= 2 && inner.length <= 200 ? inner : "";
    }
  }
  return "";
};

export const extractLiterals = (files: string[], cwd: string): LiteralSite[] => {
  const out: LiteralSite[] = [];
  for (const [lang, langFiles] of groupByLang(files)) {
    const matches = patternRunAll(STRING_PATTERNS[lang] ?? [], lang, langFiles, cwd);
    for (const m of matches) {
      const t = stripQuotes(m.text);
      if (t) out.push({ file: m.file, line: m.line, text: t });
    }
  }
  out.push(...extractConfigLiterals(files, cwd));
  for (const f of files) {
    if (isConfigFile(f)) continue;
    let src = "";
    try {
      src = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    src.split("\n").forEach((lineText, i) => {
      TEMPLATE_RE.lastIndex = 0;
      for (let m; (m = TEMPLATE_RE.exec(lineText)); ) {
        const t = m[1]!.trim();
        if (t.length >= 2) out.push({ file: f, line: i + 1, text: t });
      }
    });
  }
  return dedupe(out, (l) => `${l.file}|${l.line}|${l.text}`);
};

const dedupe = <T>(arr: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};
