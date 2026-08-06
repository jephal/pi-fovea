// The extension entry as pi sees it: register the four tools, execute one
// through the pi tool contract (TypeBox params, ctx.cwd), get contract-shaped
// results.

import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { resetSessions } from "../src/core/session.js";
import { hasAstGrep } from "../src/core/astgrep.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;

interface ToolDef {
  name: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: { cwd: string }) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

const load = () => {
  const tools = new Map<string, ToolDef>();
  const commands: string[] = [];
  extension({
    on: () => {},
    registerTool: (d: ToolDef) => tools.set(d.name, d),
    registerCommand: (name: string) => commands.push(name),
  } as never);
  return { tools, commands };
};

describe.skipIf(!hasAstGrep())("extension entry", () => {
  it("registers the four ops as pi tools plus the status command", () => {
    const { tools, commands } = load();
    for (const name of ["fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact"]) {
      expect(tools.has(name), name).toBe(true);
    }
    expect(commands).toContain("fovea-status");
  });

  it("fovea_focus executes through the pi tool contract", async () => {
    resetSessions();
    const { tools } = load();
    const focusTool = tools.get("fovea_focus")!;
    const res = await focusTool.execute("t1", { query: "GetUserHandler" }, new AbortController().signal, undefined, { cwd: FIXTURE });
    const text = res.content[0]!.text;
    expect(text).toContain("fovea focus");
    expect(text).toContain("server/users.go");
    expect(Number(res.details.shown)).toBeGreaterThan(0);
  });

  it("fovea_impact executes and respects the what-if mode", async () => {
    resetSessions();
    const { tools } = load();
    const impactTool = tools.get("fovea_impact")!;
    const res = await impactTool.execute("t2", { symbols: ["LoadUser"], includeUncommitted: false, maxTokens: 1200 }, new AbortController().signal, undefined, { cwd: FIXTURE });
    const text = res.content[0]!.text;
    expect(text).toContain("fovea impact");
    expect(text).toContain("web/api.ts");
  });
});
