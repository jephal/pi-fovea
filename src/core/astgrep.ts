// Thin runner over the ast-grep CLI. All extraction goes through here.
// Resolution: FOVEA_AST_GREP env var, then `ast-grep` on PATH.
//
// Everything is async and gated: a cold build fans chunk invocations out to
// SPAWN_CONCURRENCY processes instead of serializing spawnSync behind the
// TUI's event loop; the loop never stalls waiting on a child process.

import { execFile, spawnSync } from "node:child_process";
import { SPAWN_CONCURRENCY, mapLimit, spawnGate } from "./asyncutil.js";

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

// One spawnSync probe per binary path, memoized: ensureState used to pay a
// ~40ms subprocess on EVERY invocation. Success is sticky; failures re-probe
// after a short TTL so an install mid-session self-heals without a reload.
const availability = new Map<string, { ok: boolean; at: number }>();
const availabilityInflight = new Map<string, Promise<boolean>>();
const FAILURE_TTL_MS = 15_000;

export const hasAstGrep = (): boolean => {
  const bin = binary();
  const hit = availability.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.ok;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const ok = !r.error && r.status === 0;
  availability.set(bin, { ok, at: Date.now() });
  return ok;
};

/** Non-blocking availability probe for extension hooks and graph builds. */
export const hasAstGrepAsync = (): Promise<boolean> => {
  const bin = binary();
  const hit = availability.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) return Promise.resolve(hit.ok);
  const pending = availabilityInflight.get(bin);
  if (pending) return pending;
  const probe = spawnGate.run(
    () => new Promise<boolean>((resolve) => {
      execFile(bin, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (error) => {
        resolve(!error);
      });
    }),
  ).then((ok) => {
    availability.set(bin, { ok, at: Date.now() });
    return ok;
  }).finally(() => availabilityInflight.delete(bin));
  availabilityInflight.set(bin, probe);
  return probe;
};

// Import-file argument lists on Windows cap around 8k chars; keep chunks
// conservative. Chunk count = ceil(files / CHUNK) per stage invocation.
const CHUNK = 160;

// Extraction honesty ledger: a failed ast-grep invocation implicates every
// file in its chunk. build.ts drains this once per fact pass and folds it
// into the extraction report surfaced by tools, /fovea status, `fovea status`.
export interface ExtractionFailure {
  op: "outline" | "outline-structured" | "run";
  lang?: string;
  files: string[];
}
const failures: ExtractionFailure[] = [];
const recordFailure = (op: ExtractionFailure["op"], files: string[], lang?: string): void => {
  failures.push({ op, lang, files });
};
export const drainExtractionFailures = (): ExtractionFailure[] => failures.splice(0, failures.length);

const RUN_TIMEOUT = 120_000;
// 160-file chunks answer a few MB typically; the cap exists so a pathological
// JSON dump fails one chunk instead of inflating the gate's resident set.
const RUN_MAX_BUFFER = 16 * 1024 * 1024;

interface RunResult { ok: boolean; stdout: string; split: boolean }

const run = async (args: string[], cwd: string): Promise<RunResult> =>
  spawnGate.run(
    () =>
      new Promise<RunResult>((resolve) => {
        execFile(
          binary(),
          args,
          { cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER },
          (error, stdout, stderr) => {
            // A maxBuffer breach is a memory guard, not an extraction error:
            // rerun smaller chunks until each response fits the same ceiling.
            if (error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ ok: false, stdout: "", split: true });
              return;
            }
            // Spawn errors surface a non-numeric code (ENOENT/EACCES); a
            // numeric code is a real process exit. Killed/signaled = timeout.
            if (error && typeof error.code !== "number") {
              resolve({ ok: false, stdout: "", split: false });
              return;
            }
            const status = (error && typeof error.code === "number" ? error.code : 0) as number;
            if (status !== 0) {
              // grep convention: `ast-grep run` exits 1 silently on zero
              // matches, so a bare non-zero status is not a failure. Only a
              // verbose one is.
              if ((stderr ?? "").trim()) {
                resolve({ ok: false, stdout: "", split: false });
                return;
              }
              resolve({ ok: true, stdout: "", split: false });
              return;
            }
            resolve({ ok: true, stdout: stdout ?? "", split: false });
          },
        );
      }),
  );

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

// Chunks of one stage fan out concurrently, bounded by the shared spawn gate.
// Order is preserved (mapLimit keeps indices) so concatenated text output
// stays deterministic for the outline parser.
const runChunked = async (
  files: string[],
  chunkArgs: (chunk: string[]) => string[],
  cwd: string,
): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));
  const adaptive = async (chunk: string[]): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
    const result = await run(chunkArgs(chunk), cwd);
    if (!result.split || chunk.length === 1) return [{ chunk, result }];
    const middle = Math.ceil(chunk.length / 2);
    const halves = await Promise.all([
      adaptive(chunk.slice(0, middle)),
      adaptive(chunk.slice(middle)),
    ]);
    return [...halves[0], ...halves[1]];
  };
  const settled = await mapLimit(chunks, SPAWN_CONCURRENCY, adaptive);
  return settled.flat();
};

// Expanded JSON preserves each member's own range and signature. Return
// undefined when the installed ast-grep predates this interface so callers can
// fall back without presenting parent locations as exact member locations.
export const outlineStructured = async (files: string[], _lang: string, cwd: string): Promise<OutlineFile[] | undefined> => {
  const out: OutlineFile[] = [];
  // A subprocess failure here is NOT recorded: extractSymbols falls back to
  // the text outline for old ast-grep versions, and that text run is what
  // records a genuine failure (old versions must not read as failures).
  const settled = await runChunked(
    files,
    (chunk) => ["outline", "--json=compact", "--view=expanded", ...chunk],
    cwd,
  );
  for (const { result } of settled) {
    if (!result.stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as OutlineFile[];
      if (!Array.isArray(parsed)) return undefined;
      for (const file of parsed) out.push(file);
    } catch {
      return undefined;
    }
  }
  return out;
};

export const outline = async (files: string[], lang: string, cwd: string): Promise<string> => {
  let out = "";
  const settled = await runChunked(files, (chunk) => ["outline", ...chunk], cwd);
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("outline", chunk, lang);
      continue;
    }
    out += result.stdout;
  }
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
export const patternRun = async (
  pattern: string,
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const out: AgMatch[] = [];
  const settled = await runChunked(
    files,
    (chunk) => ["run", "--pattern", pattern, "--lang", lang, "--json=compact", ...chunk],
    cwd,
  );
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!result.stdout.trim()) continue;
    let parsed: RawMatch[];
    try {
      parsed = JSON.parse(result.stdout) as RawMatch[];
    } catch {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!Array.isArray(parsed)) {
      recordFailure("run", chunk, lang);
      continue;
    }
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
// Patterns run concurrently (bounded by the spawn gate): per-stage latency
// collapses from O(patterns * chunks) processes-sequential to ~the slowest
// slice of chunks wide SPAWN_CONCURRENCY.
export const patternRunAll = async (
  patterns: string[],
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const perPattern = await mapLimit(patterns, patterns.length || 1, (p) => patternRun(p, lang, files, cwd));
  const out: AgMatch[] = [];
  for (const matches of perPattern) for (const m of matches) out.push(m);
  return out;
};
