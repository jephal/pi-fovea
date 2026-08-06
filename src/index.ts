// pi-fovea extension entry. Registers the foveated-diffusion tools and a
// status command. All state lives in ops/session modules (in-memory,
// per-conversation); the on-disk content-hash cache makes graph rebuilds
// incremental across sessions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dwell, focus, impact, sketch } from "./core/ops.js";
import { resetSessions } from "./core/session.js";

const BudgetParam = Type.Optional(
  Type.Number({ description: "Max tokens for the response (256..16000). Estimate: 4 chars/token.", minimum: 256, maximum: 16000 }),
);
const RootParam = Type.Optional(
  Type.String({ description: "Repo root to map. Defaults to the session working directory." }),
);

const text = (s: string) => ({ type: "text" as const, text: s });

export default function fovea(pi: ExtensionAPI) {
  pi.on("session_start", async (event) => {
    if (event.reason === "new" || event.reason === "fork") resetSessions();
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
        const r = sketch(root, params.maxTokens);
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
        const r = focus(root, params.query, params.maxTokens);
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
        const r = dwell(root, params.factor, params.maxTokens);
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
      includeUncommitted: Type.Optional(Type.Boolean({ description: "Seed from uncommitted changes (default true)." })),
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
          budget: params.maxTokens,
        });
        return { content: [text(r.text)], details: r.details };
      } catch (e) {
        return { content: [text(String(e instanceof Error ? e.message : e))], details: {}, isError: true };
      }
    },
  });

  pi.registerCommand("fovea-status", {
    description: "Show pi-fovea graph/session stats for this repo",
    handler: async (_args, ctx) => {
      try {
        const s = sketch(ctx.cwd, 256);
        ctx.ui.notify(`pi-fovea: ${s.details.files ?? 0} files, ${s.details.nodes ?? 0} nodes, ${s.details.anchors ?? 0} anchors`, "info");
      } catch (e) {
        ctx.ui.notify(`pi-fovea: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });
}
