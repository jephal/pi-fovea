// The extension entry as pi sees it: register the graph tools, optionally
// replace grep, and execute through Pi's TypeBox tool contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { resetSessions } from "../src/core/session.js";
import { hasAstGrep } from "../src/core/astgrep.js";
import { DEFAULT_FOVEA_CONFIG } from "../src/core/config.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;

interface ToolDef {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: { cwd: string; isProjectTrusted: () => boolean },
  ) => Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

type EventHandler = (event: Record<string, unknown>, ctx: ReturnType<typeof fakeCtx>) => unknown;

const fakeCtx = (cwd: string, trusted = false) => ({
  cwd,
  isProjectTrusted: () => trusted,
});

const load = () => {
  const tools = new Map<string, ToolDef>();
  const commands: string[] = [];
  const handlers = new Map<string, EventHandler[]>();
  extension({
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage: async () => {},
    registerTool: (definition: ToolDef) => tools.set(definition.name, definition),
    registerCommand: (name: string) => commands.push(name),
  } as never);
  const emit = async (
    name: string,
    event: Record<string, unknown>,
    ctx: ReturnType<typeof fakeCtx>,
  ): Promise<void> => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { tools, commands, emit };
};

const enableGrep = async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-grep-"));
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "fovea.json"),
    JSON.stringify({ tools: { replaceGrep: true } }),
  );
  const loaded = load();
  await loaded.emit("session_start", { reason: "reload" }, fakeCtx(root, true));
  return { root, ...loaded };
};

describe("extension entry", () => {
  it("registers four graph tools and /fovea before session startup", () => {
    const { tools, commands } = load();
    for (const name of ["fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact"]) {
      expect(tools.has(name), name).toBe(true);
    }
    expect(tools.has("grep")).toBe(false);
    expect(commands).toContain("fovea");
    expect(DEFAULT_FOVEA_CONFIG.tools.replaceGrep).toBe(true);
  });

  it("registers an exact grep-compatible schema when the project setting is enabled", async () => {
    const loaded = await enableGrep();
    try {
      const grep = loaded.tools.get("grep");
      expect(grep).toBeDefined();
      const schema = grep!.parameters as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties)).toEqual([
        "pattern",
        "path",
        "glob",
        "ignoreCase",
        "literal",
        "context",
        "limit",
      ]);
      expect(schema.required).toEqual(["pattern"]);
    } finally {
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasAstGrep())("extension execution", () => {
  it("fovea_focus executes through the Pi tool contract", async () => {
    resetSessions();
    const { tools } = load();
    const focusTool = tools.get("fovea_focus")!;
    const result = await focusTool.execute(
      "t1",
      { query: "GetUserHandler" },
      new AbortController().signal,
      undefined,
      fakeCtx(FIXTURE),
    );
    expect(result.content[0]!.text).toContain("fovea focus");
    expect(result.content[0]!.text).toContain("server/users.go");
    expect(Number(result.details.shown)).toBeGreaterThan(0);
  });

  it("the grep override delegates its pattern to Fovea", async () => {
    resetSessions();
    const loaded = await enableGrep();
    try {
      const result = await loaded.tools.get("grep")!.execute(
        "t-grep",
        { pattern: "GetUserHandler", path: "server" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(result.content[0]!.text).toContain("fovea grep");
      expect(result.content[0]!.text).toContain("server/users.go");
      expect(result.details).toMatchObject({ backend: "fovea", query: "GetUserHandler" });
    } finally {
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });

  it("fovea_impact executes and respects the what-if mode", async () => {
    resetSessions();
    const { tools } = load();
    const impactTool = tools.get("fovea_impact")!;
    const result = await impactTool.execute(
      "t2",
      { symbols: ["LoadUser"], includeUncommitted: false, maxTokens: 1200 },
      new AbortController().signal,
      undefined,
      fakeCtx(FIXTURE),
    );
    expect(result.content[0]!.text).toContain("fovea impact");
    expect(result.content[0]!.text).toContain("web/api.ts");
  });
});
