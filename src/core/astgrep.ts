// Thin runner over the ast-grep CLI. All extraction goes through here.
// Resolution: FOVEA_AST_GREP env var, then `ast-grep` on PATH.

import { spawnSync } from "node:child_process";

export const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "Tsx", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "Tsx", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  // Second tier: symbols via ast-grep outline; name derivation is heuristic.
  ex: "Elixir", exs: "Elixir",
  rb: "Ruby",
  c: "C", h: "C",
  cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  java: "Java",
  kt: "Kotlin", kts: "Kotlin",
  lua: "Lua",
  php: "Php",
  swift: "Swift",
  scala: "Scala",
  hs: "Haskell",
  sh: "Bash",
};

// Compiled artifacts masquerading as source extensions.
const BINARY_EXTS = new Set(["beam", "pyc", "o", "obj", "so", "a", "d"]);
export const isBinaryExt = (file: string): boolean =>
  BINARY_EXTS.has(file.split(".").pop()?.toLowerCase() ?? "");

// Non-code files: literals are regex-extracted so config/spec files can join.
export const CONFIG_EXTS = new Set(["yaml", "yml", "json", "toml", "env", "tf", "hcl", "md"]);

export interface AgMatch {
  file: string;                    // as passed to ast-grep (repo-relative)
  line: number;                    // 1-indexed
  text: string;                    // full matched node text
  single: Record<string, string>;  // $VAR -> text (single metavars)
  multi: Record<string, string[]>; // $$$VAR -> texts
}

const binary = (): string => process.env.FOVEA_AST_GREP ?? "ast-grep";

export const hasAstGrep = (): boolean => {
  const r = spawnSync(binary(), ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
};

const CHUNK = 160;

const run = (args: string[], cwd: string): string => {
  const res = spawnSync(binary(), args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) return "";
  return res.stdout ?? "";
};

export const langOf = (file: string): string | undefined => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
};

export const isConfigFile = (file: string): boolean => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONFIG_EXTS.has(ext);
};

export const groupByLang = (files: string[]): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const lang = langOf(f);
    if (!lang) continue;
    const arr = m.get(lang) ?? [];
    arr.push(f);
    m.set(lang, arr);
  }
  return m;
};

// `ast-grep outline` is the uniform symbol source across languages.
// Expanded JSON is primary; the legacy text view remains as a compatibility fallback.
export interface OutlineRange {
  start: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface OutlineSymbol {
  role: "item" | "member";
  symbolType: string;
  name: string;
  range: OutlineRange;
  signature: string;
  astKind?: string;
  members?: OutlineSymbol[];
}

export interface OutlineFile {
  path: string;
  language: string;
  items: OutlineSymbol[];
}

// Expanded JSON preserves each member's own range and signature. Return
// undefined when the installed ast-grep predates this interface so callers can
// fall back without presenting parent locations as exact member locations.
export const outlineStructured = (files: string[], lang: string, cwd: string): OutlineFile[] | undefined => {
  const out: OutlineFile[] = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const stdout = run(
      ["outline", "--json=compact", "--view=expanded", ...files.slice(i, i + CHUNK)],
      cwd,
    );
    if (!stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(stdout) as OutlineFile[];
      if (!Array.isArray(parsed)) return undefined;
      for (const file of parsed) out.push(file);
    } catch {
      return undefined;
    }
  }
  void lang;
  return out;
};

export const outline = (files: string[], lang: string, cwd: string): string => {
  let out = "";
  for (let i = 0; i < files.length; i += CHUNK) {
    out += run(["outline", ...files.slice(i, i + CHUNK)], cwd);
  }
  void lang;
  return out;
};

interface RawMatch {
  text: string;
  range: { start: { line: number; column: number } };
  file: string;
  metaVariables?: {
    single?: Record<string, { text: string }>;
    multi?: Record<string, Array<{ text: string }>>;
  };
}

// `ast-grep run --pattern` with JSON output for a set of files of one language.
export const patternRun = (
  pattern: string,
  lang: string,
  files: string[],
  cwd: string,
): AgMatch[] => {
  const out: AgMatch[] = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const stdout = run(
      ["run", "--pattern", pattern, "--lang", lang, "--json=compact", ...files.slice(i, i + CHUNK)],
      cwd,
    );
    if (!stdout.trim()) continue;
    let parsed: RawMatch[];
    try {
      parsed = JSON.parse(stdout) as RawMatch[];
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const m of parsed) {
      const single: Record<string, string> = {};
      const multi: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(m.metaVariables?.single ?? {})) single[k] = v.text;
      for (const [k, v] of Object.entries(m.metaVariables?.multi ?? {})) multi[k] = v.map((x) => x.text);
      out.push({ file: m.file, line: m.range.start.line + 1, text: m.text, single, multi });
    }
  }
  return out;
};

// First match of any of the patterns, per language/file set, concatenated.
// Spread-pushing big match arrays overflows the argument-list limit, so
// concatenate manually.
const pushAll = <T>(out: T[], more: T[]): void => { for (const x of more) out.push(x); };

// First match of any of the patterns, per language/file set, concatenated.
export const patternRunAll = (
  patterns: string[],
  lang: string,
  files: string[],
  cwd: string,
): AgMatch[] => {
  const out: AgMatch[] = [];
  for (const p of patterns) pushAll(out, patternRun(p, lang, files, cwd));
  return out;
};
