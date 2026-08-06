// Git-history co-change conductance. The static graph says what talks to
// what *by construction*; the history graph says what *actually* moves
// together — the signal impact needs when two files share no static edge but
// always get edited in the same commits. Bounded by commit window and pair
// caps; cached by HEAD sha + tracked-file hash. All git IO is async behind
// the spawn gate.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { gitHead, gitOut, gitPrefix, gitRelativePath } from "./git.js";

const LOG_COMMITS = 400;
const MAX_FILES_PER_COMMIT = 24; // squashed monsters carry no pair signal
const MIN_SHARED = 2;            // a single collision is noise
const MAX_PAIRS_PER_FILE = 16;   // cap each file's history fan-out

interface CacheShape { head: string; key: string; pairs: Array<[string, string, number]>; }

const cachePath = (root: string): string =>
  joinPath(tmpdir(), `pi-fovea-cochange-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

// coChangePairs returns [fileA, fileB, conductance] pairs. `filesInGraph`
// restricts to files we actually track, so vendored churn is excluded.
export const coChangePairs = async (root: string, filesInGraph: string[]): Promise<Array<[string, string, number]>> => {
  const head = (await gitHead(root)) ?? "";
  if (!head) return []; // not a git repo
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return [];
  const tracked = new Set(filesInGraph);
  const key = createHash("sha1").update([...tracked].sort().join("\n")).digest("hex").slice(0, 12);
  const cp = cachePath(root);
  try {
    const cached = JSON.parse(await readFile(cp, "utf8")) as CacheShape;
    if (cached.head === head && cached.key === key) return cached.pairs;
  } catch { /* recompute */ }

  const log = await gitOut(root, ["log", "--format=%x00", "--numstat", "-n", String(LOG_COMMITS), "--no-renames", "--diff-filter=AMR", "--", "."]) ?? "";
  // numstat lines: "<added>\t<deleted>\t<file>"; commits separated by NUL lines.
  const pairCount = new Map<string, number>();
  const soloCount = new Map<string, number>();
  let cur: string[] = [];
  const flush = (): void => {
    const fs = [...new Set(cur)].filter((f) => tracked.has(f));
    cur = [];
    if (fs.length < 2 || fs.length > MAX_FILES_PER_COMMIT) return;
    fs.sort();
    for (const f of fs) soloCount.set(f, (soloCount.get(f) ?? 0) + 1);
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const k = `${fs[i]}|${fs[j]}`;
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
      }
    }
  };
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    if (line.includes("\0")) { flush(); continue; }
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const secondTab = line.indexOf("\t", tab + 1);
    if (secondTab < 0) continue;
    const file = gitRelativePath(line.slice(secondTab + 1).trim(), prefix);
    if (file) cur.push(file);
  }
  flush();

  // Conductance: Jaccard-tilted confidence, mildly compressed by count so a
  // pair changed 40 times beats one changed twice without swamping the graph.
  const scored: Array<[string, string, number]> = [];
  for (const [k, n] of pairCount) {
    if (n < MIN_SHARED) continue;
    const [a, b] = k.split("|") as [string, string];
    const union = (soloCount.get(a) ?? 0) + (soloCount.get(b) ?? 0) - n;
    if (union <= 0) continue;
    const jaccard = n / union;
    const w = Math.min(0.5, 0.08 + 0.55 * jaccard + 0.10 * Math.min(n / 10, 1));
    scored.push([a, b, Number(w.toFixed(3))]);
  }

  // Keeper filter: per-file top partners only.
  const perFile = new Map<string, number[]>();
  scored.forEach((p, i) => {
    for (const f of [p[0], p[1]]) {
      (perFile.get(f) ?? perFile.set(f, []).get(f)!).push(i);
    }
  });
  const keep = new Set<number>();
  for (const [, idxs] of perFile) {
    idxs.sort((x, y) => scored[y]![2] - scored[x]![2]);
    for (const i of idxs.slice(0, MAX_PAIRS_PER_FILE)) keep.add(i);
  }
  const pairs = scored.filter((_, i) => keep.has(i));

  try {
    await mkdir(dirname(cp), { recursive: true });
    await writeFile(cp, JSON.stringify({ head, key, pairs } satisfies CacheShape));
  } catch { /* cache is an optimization */ }
  return pairs;
};
