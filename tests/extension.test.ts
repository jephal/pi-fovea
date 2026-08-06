// The extension entry as pi sees it: register the graph tools, optionally
// replace grep, and execute through Pi's TypeBox tool contract.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { resetSessions } from "../src/core/session.js";
import { hasAstGrep } from "../src/core/astgrep.js";
import { DEFAULT_FOVEA_CONFIG } from "../src/core/config.js";
import { resetSyncBaselines } from "../src/core/sync.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;

interface ToolDef {
  name: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
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
interface CommandDef {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
  handler: (args: string, ctx: ReturnType<typeof fakeCtx>) => Promise<void>;
}

const fakeCtx = (cwd: string, trusted = false) => ({
  cwd,
  hasUI: false,
  isIdle: () => true,
  isProjectTrusted: () => trusted,
  reload: async () => {},
  ui: { notify: () => {} },
});

const load = () => {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const handlers = new Map<string, EventHandler[]>();
  extension({
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      messages.push({ message, options });
    },
    exec: async (command: string, args: string[]) => {
      try {
        return { code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" };
      } catch (error) {
        return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    registerTool: (definition: ToolDef) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: CommandDef) => commands.set(name, definition),
  } as never);
  const emit = async (
    name: string,
    event: Record<string, unknown>,
    ctx: ReturnType<typeof fakeCtx>,
  ): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { tools, commands, messages, emit };
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
      expect(tools.get(name)?.promptSnippet, name).toBeTruthy();
      expect(tools.get(name)?.promptGuidelines?.some((guideline) => guideline.includes(name)), name).toBe(true);
    }
    expect(tools.has("grep")).toBe(false);
    expect(commands.has("fovea")).toBe(true);
    expect(commands.get("fovea")!.getArgumentCompletions?.("").map((item) => item.value)).toEqual([
      "status", "settings", "reset", "reload",
    ]);
    expect(DEFAULT_FOVEA_CONFIG.tools.replaceGrep).toBe(true);
  });

  it("reloads extension source through /fovea reload", async () => {
    const { commands } = load();
    const ctx = fakeCtx(FIXTURE);
    const reload = vi.fn(async () => {});
    ctx.reload = reload;
    await commands.get("fovea")!.handler("reload", ctx);
    expect(reload).toHaveBeenCalledOnce();
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
  it("reports loaded versions, index coverage, anchor scopes, and active modes", async () => {
    const { commands } = load();
    const ctx = fakeCtx(FIXTURE);
    const notify = vi.fn();
    ctx.ui.notify = notify;
    await commands.get("fovea")!.handler("status", ctx);
    const message = String(notify.mock.calls[0]?.[0]);
    expect(message).toMatch(/pi-fovea \d+\.\d+\.\d+/);
    expect(message).toContain("tracked files indexed");
    expect(message).toContain("production anchors");
    expect(message).toContain("sync continuous");
    expect(message).toContain("grep hybrid");
    expect(message).toContain("ast-grep");
  });

  it("fovea_focus executes through the Pi tool contract", async () => {
    resetSessions();
    const { tools } = load();
    const focusTool = tools.get("fovea_focus")!;
    const schema = focusTool.parameters as { properties: Record<string, unknown> };
    for (const property of ["query", "path", "language", "kind", "fresh", "root", "maxTokens"]) {
      expect(schema.properties).toHaveProperty(property);
    }
    const updates: unknown[] = [];
    const result = await focusTool.execute(
      "t1",
      { query: "GetUserHandler", fresh: true, path: "server" },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      fakeCtx(FIXTURE),
    );
    expect(result.content[0]!.text).toContain("fovea focus");
    expect(result.content[0]!.text).toContain("server/users.go");
    expect(Number(result.details.shown)).toBeGreaterThan(0);
    expect(Array.isArray(result.details.nodes)).toBe(true);
    expect(Array.isArray(result.details.suggestedReads)).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it("uses Fovea only for bare grep symbol queries", async () => {
    resetSessions();
    const loaded = await enableGrep();
    try {
      const graph = await loaded.tools.get("grep")!.execute(
        "t-grep-graph",
        { pattern: "GetUserHandler" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(graph.content[0]!.text).toContain("fovea grep");
      expect(graph.content[0]!.text).toContain("server/users.go");
      expect(graph.details).toMatchObject({ backend: "fovea", query: "GetUserHandler" });

      const graphAgain = await loaded.tools.get("grep")!.execute(
        "t-grep-graph-again",
        { pattern: "GetUserHandler" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(graphAgain.content[0]!.text).toBe(graph.content[0]!.text);
      const qualified = await loaded.tools.get("grep")!.execute(
        "t-grep-qualified",
        { pattern: "AirportsController.search" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(qualified.content[0]!.text).toContain("fovea grep");
      expect(qualified.content[0]!.text).toContain("web/airports.controller.ts");

      const route = await loaded.tools.get("grep")!.execute(
        "t-grep-route",
        { pattern: "/api/users/{id}" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(route.content[0]!.text).toContain("fovea grep");
      expect(route.content[0]!.text).toContain("server/main.go");

      const regex = await loaded.tools.get("grep")!.execute(
        "t-grep-regex",
        { pattern: "Get.*Handler" },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(regex.content[0]!.text).toContain("func GetUserHandler");
      expect(regex.content[0]!.text).not.toContain("fovea grep");

      const native = await loaded.tools.get("grep")!.execute(
        "t-grep-native",
        { pattern: "GetUserHandler", path: "server", literal: true, context: 1 },
        new AbortController().signal,
        undefined,
        fakeCtx(FIXTURE),
      );
      expect(native.content[0]!.text).toContain("func GetUserHandler");
      expect(native.content[0]!.text).not.toContain("fovea grep");
    } finally {
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });


  it("injects out-of-band drift before the next model call", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-before-agent-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await loaded.emit("before_agent_start", { prompt: "first" }, ctx);
      const main = path.join(root, "server/main.go");
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/idle", server.GetUserHandler)',
        ),
      );
      const results = await loaded.emit("before_agent_start", { prompt: "continue" }, ctx);
      const injected = results.find((result) => typeof result === "object" && result !== null) as {
        message: Record<string, unknown>;
      };
      expect(injected.message).toMatchObject({ customType: "pi-fovea-sync", display: true });
      expect(String(injected.message.content)).toContain("GET /api/users/{*}/idle");
      expect(loaded.messages).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("delivers continuous sync intelligence as an immediate steer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-steer-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await loaded.emit("before_agent_start", { prompt: "change the route" }, ctx); // establish pre-edit baseline
      await loaded.emit("turn_start", {}, ctx);
      const main = path.join(root, "server/main.go");
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/steer", server.GetUserHandler)',
        ),
      );
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(loaded.messages[0]!.message).toMatchObject({
        customType: "pi-fovea-sync",
        display: true,
      });
      expect(String(loaded.messages[0]!.message.content)).toContain("Steer: account for this update");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
