#!/usr/bin/env tsx
// pi-fovea CLI — the extension without pi, for agent shells and pipes:
//   fovea status [root]
//   fovea sketch [root] [budget]
//   fovea focus [root] <query> [budget]
//   fovea dwell [root] [factor] [budget]     (deepens the in-process focus)
//   fovea impact [root] [--files a,b] [--symbols x,y] [--base ref] [--no-uncommitted] [budget]
//   fovea anchors [root] [filter]             (every feature anchor, sorted)
//
// The CLI is stateless across invocations (dwell needs a prior focus in the
// same process — combine ops inside pi, where sessions persist); stdout is
// the rendered field, nothing else, so it composes with head/grep/$().

import { ensureState, sketch, focus, dwell, impact } from "./src/core/ops.js";

const [, , cmd = "status", ...argv] = process.argv;

const VALUE_FLAGS = new Set(["files", "symbols", "base"]);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i] ?? "");
    else flags.set(name, true);
  } else {
    pos.push(a);
  }
}
const str = (name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const numAt = (i: number): number | undefined => {
  const n = Number(pos[i]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
// Root is the first positional that names a path; everything else is arg data.
const rootAt = (i: number): string => {
  const p = pos[i];
  return p !== undefined && (p.includes("/") || p === ".") ? p : ".";
};

try {
  let out = "";
  if (cmd === "status") {
    const s = sketch(rootAt(0), 256);
    out = `${s.details.files} files, ${s.details.nodes} nodes, ${s.details.anchors} anchors`;
  } else if (cmd === "sketch") {
    const root = rootAt(0);
    const B = numAt(pos[0] === root && pos.length > 1 ? 1 : 0) ?? 1400;
    out = sketch(root, B).text;
  } else if (cmd === "focus") {
    const root = rootAt(0);
    const q = pos[0] !== root ? pos[0] : pos[1];
    if (!q) { console.error("fovea focus <query>"); process.exit(2); }
    let bi = pos.indexOf(q) + 1;
    out = focus(root, q, numAt(bi) ?? 2000).text;
  } else if (cmd === "dwell") {
    const root = rootAt(0);
    const factor = numAt(pos[0] === root ? 1 : 0) ?? 2;
    const B = numAt(pos[0] === root ? 2 : 1) ?? 2000;
    out = dwell(root, factor, B).text;
  } else if (cmd === "impact") {
    const root = rootAt(0);
    const B = pos[0] === root ? numAt(1) : numAt(0);
    out = impact(root, {
      files: str("files")?.split(",").filter(Boolean),
      symbols: str("symbols")?.split(",").filter(Boolean),
      base: str("base"),
      includeUncommitted: !flags.has("no-uncommitted"),
      budget: B ?? 2000,
    }).text;
  } else if (cmd === "anchors") {
    const root = rootAt(0);
    const filter = pos.find((p) => p !== root);
    const rows = ensureState(root).graph.anchors
      .map((a) => `${a.kind}\t${a.id}\t${a.file}:${a.line}`)
      .filter((r) => !filter || r.includes(filter))
      .sort();
    out = rows.join("\n");
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
  console.log(out);
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
