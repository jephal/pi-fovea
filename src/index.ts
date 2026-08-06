// pi-fovea extension entry. Registers the foveated-diffusion tools and a
// status command. All state lives in ops/session modules (in-memory,
// per-conversation); the on-disk content-hash cache makes graph rebuilds
// incremental across sessions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultAgentDir, loadFoveaConfig, type FoveaConfig } from "./core/config.js";
import { dwell, focus, impact, sketch } from "./core/ops.js";
import { resetSessions } from "./core/session.js";
import { resetSyncBaselines, sync } from "./core/sync.js";
import { openFoveaSettings } from "./ui/settings.js";

const BudgetParam = Type.Optional(
  Type.Number({ description: "Max tokens for the response (256..16000). Estimate: 4 chars/token.", minimum: 256, maximum: 16000 }),
);
const RootParam = Type.Optional(
  Type.String({ description: "Repo root to map. Defaults to the session working directory." }),
);
const GrepParams = Type.Object({
  pattern: Type.String({ description: "Symbol, route, environment key, or file query for the Fovea code graph." }),
  path: Type.Optional(Type.String({ description: "Compatibility path hint. Used as a fallback graph seed when pattern finds no node." })),
  glob: Type.Optional(Type.String({ description: "Accepted for grep-call compatibility; Fovea navigation is graph-based rather than glob-filtered." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Accepted for grep-call compatibility; Fovea symbol matching is already case-insensitive." })),
  literal: Type.Optional(Type.Boolean({ description: "Accepted for grep-call compatibility; the pattern is interpreted as a graph query." })),
  context: Type.Optional(Type.Number({ description: "Accepted for grep-call compatibility; graph neighbors replace line context." })),
  limit: Type.Optional(Type.Number({ description: "Accepted for grep-call compatibility; output is controlled by tools.defaultBudget." })),
});

const text = (s: string) => ({ type: "text" as const, text: s });

export default function fovea(pi: ExtensionAPI) {
  // Per-root config cache; invalidated by settings saves (/fovea settings).
  const configs = new Map<string, FoveaConfig>();
  const configFor = (root: string, trusted = false, agentDir?: string): FoveaConfig => {
    const hit = configs.get(root);
    if (hit) return hit;
    const cfg = loadFoveaConfig({ cwd: root, agentDir: agentDir ?? defaultAgentDir(), projectTrusted: trusted });
    configs.set(root, cfg);
    return cfg;
  };

  let grepOverrideRegistered = false;
  const registerGrepOverride = (): void => {
    if (grepOverrideRegistered) return;
    grepOverrideRegistered = true;
    pi.registerTool({
      name: "grep",
      label: "grep (Fovea)",
      description:
        "Navigate the pi-fovea code graph through grep's familiar argument shape. Finds symbols, routes, environment keys, files, and their warm dependencies; it does not perform literal line matching. Use bash with rg only when exact text or regex matches are required.",
      promptSnippet: "Navigate the Fovea code graph with a grep-compatible query",
      promptGuidelines: [
        "Use grep for graph-backed repository navigation before exact text search; when the Fovea override is active, grep centers the code graph on pattern and returns warm dependencies rather than matching lines.",
        "Use bash with rg only when an exact literal or regular-expression text match is required after the Fovea-backed grep result.",
      ],
      parameters: GrepParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const root = ctx.cwd;
        const budget = configFor(root, ctx.isProjectTrusted()).tools.defaultBudget;
        const pattern = params.pattern.trim();
        const pathHint = params.path?.replace(/^@/, "").trim();
        let query = pattern || pathHint || params.pattern;
        try {
          let result = focus(root, query, budget);
          if (Number(result.details.seeds ?? 0) === 0 && pathHint && pathHint !== "." && pathHint !== query) {
            query = pathHint;
            result = focus(root, query, budget);
          }
          return {
            content: [text(result.text.replace(/^fovea focus/, "fovea grep"))],
            details: { ...result.details, backend: "fovea", query },
          };
        } catch (error) {
          return {
            content: [text(String(error instanceof Error ? error.message : error))],
            details: { backend: "fovea", query },
            isError: true,
          };
        }
      },
    });
  };

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "fork") {
      resetSessions();
      resetSyncBaselines();
    }
    if (configFor(ctx.cwd, ctx.isProjectTrusted()).tools.replaceGrep) registerGrepOverride();
  });

  // Turn-sync loop. The tracker below is a hint accumulator only: pi's
  // edit/write tool starts give the warmth pass a head start, but sync relies
  // on content-hash drift, so identical detection covers fabric_exec inner
  // pi.edit calls, bash mutations, subagents, and out-of-band editor saves.
  // Pure conversation turns exit at zero cost through the version fast path.
  let turnFiles: string[] = [];
  pi.on("turn_start", () => {
    turnFiles = [];
  });
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const args = event.args as { path?: unknown };
    if (typeof args.path === "string") turnFiles.push(args.path);
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
      const rels = turnFiles
        .map((p) => (p.startsWith(ctx.cwd + "/") ? p.slice(ctx.cwd.length + 1) : p))
        .filter((p) => !p.startsWith("/"));
      turnFiles = [];
      if (!cfg.sync.enabled) return;
      const outcome = sync(ctx.cwd, {
        files: rels,
        budget: cfg.sync.budget,
        warmFileThreshold: cfg.sync.warmFileThreshold,
      });
      if (!outcome.structural) return;
      if (outcome.red && outcome.text) {
        // Lands in session context; the model sees it on the next LLM call.
        // No triggerTurn: a red flag never spends a turn on its own.
        pi.sendMessage({
          customType: "pi-fovea-sync",
          content: outcome.text,
          display: true,
        }, { deliverAs: "nextTurn" });
      } else if (cfg.sync.ackClean && ctx.hasUI) {
        ctx.ui.notify(`fovea sync clean · v ${String(outcome.details.version ?? "?")}`, "info");
      }
    } catch {
      // Turn-sync must never break the agent loop: log and move on.
    }
  });

  pi.registerTool({
    name: "fovea_sketch",
    label: "Fovea Sketch",
    description:
      "Survey a repository as a low-acuity silhouette: feature anchors (routes etc.) and directory regions ranked by heat-diffusion mass. Cheap start of the progressive-disclosure loop; follow with fovea_focus on anything interesting. Token-budgeted.",
    parameters: Type.Object({ root: RootParam, maxTokens: BudgetParam }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = params.root ?? ctx.cwd;
      try {
        const r = sketch(root, params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget);
        return { content: [text(r.text)], details: r.details };
      } catch (e) {
        return { content: [text(String(e instanceof Error ? e.message : e))], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "fovea_focus",
    label: "Fovea Focus",
    description:
      "Center the fovea on a query (symbol name, route path like /api/users/{id}, env key, or file). Returns a foveated field: hot nodes with full signatures, warm nodes as one-liners, the periphery collapsed. Sets the session focus that fovea_dwell deepens. Only new information is returned — already-shown nodes are suppressed.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name, route path, env key, or repo-relative file path." }),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = params.root ?? ctx.cwd;
      try {
        const r = focus(root, params.query, params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget);
        return { content: [text(r.text)], details: r.details };
      } catch (e) {
        return { content: [text(String(e instanceof Error ? e.message : e))], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "fovea_dwell",
    label: "Fovea Dwell",
    description:
      "Let the current focus diffuse longer (heat time t grows, default x2) and return only the newly-luminous periphery. Use after fovea_focus when the footer says more nodes are lit below threshold.",
    parameters: Type.Object({
      factor: Type.Optional(Type.Number({ description: "Multiply diffusion time by this (default 2).", minimum: 1.1, maximum: 16 })),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = params.root ?? ctx.cwd;
      try {
        const r = dwell(root, params.factor, params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget);
        return { content: [text(r.text)], details: r.details };
      } catch (e) {
        return { content: [text(String(e instanceof Error ? e.message : e))], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "fovea_impact",
    label: "Fovea Impact",
    description:
      "Seed diffusion from changed files (uncommitted changes by default, or explicit files/symbols) and rank what warms up — the predicted review/co-change cascade across languages, ordered by warmth. Run before or after edits to see what a change touches.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative changed files." })),
      symbols: Type.Optional(Type.Array(Type.String(), { description: "Changed symbol names (what-if mode)." })),
      includeUncommitted: Type.Optional(Type.Boolean({ description: "Seed from uncommitted changes (default true; ignored when base is set)." })),
      base: Type.Optional(Type.String({ description: "Base ref for PR-style cascades: seeds come from `git diff <base>...HEAD`." })),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = params.root ?? ctx.cwd;
      try {
        const r = impact(root, {
          files: params.files,
          symbols: params.symbols,
          includeUncommitted: params.includeUncommitted,
          base: params.base,
          budget: params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget,
        });
        return { content: [text(r.text)], details: r.details };
      } catch (e) {
        return { content: [text(String(e instanceof Error ? e.message : e))], details: {}, isError: true };
      }
    },
  });

  pi.registerCommand("fovea", {
    description: "pi-fovea status and settings",
    getArgumentCompletions: (prefix) =>
      ["status", "settings"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "status";
      if (sub === "settings") {
        const result = await openFoveaSettings(ctx, { onConfigApplied: () => configs.clear() });
        if (result.grepRegistrationChanged) {
          ctx.ui.notify("Reloading extensions to apply the grep tool change…", "info");
          await ctx.reload();
        }
        return;
      }
      try {
        const s = sketch(ctx.cwd, 256);
        const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(
          `pi-fovea: ${s.details.files ?? 0} files, ${s.details.nodes ?? 0} nodes, ${s.details.anchors ?? 0} anchors · sync ${cfg.sync.enabled ? "on" : "off"} · grep ${cfg.tools.replaceGrep ? "fovea" : "native"}`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`pi-fovea: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });
}
