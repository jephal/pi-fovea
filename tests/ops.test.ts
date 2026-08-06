// End-to-end over the fixture: graph build, the four ops, budget conformance,
// and the session delta contract.

import { describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { dwell, ensureState, focus, impact, sketch } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;

describe.skipIf(!hasAstGrep())("fovea ops on the minimonorepo", () => {
  it("builds the graph with anchors and cross-language join edges", () => {
    const s = ensureState(FIXTURE);
    expect(s.graph.anchors.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(s.graph.edges.map((e) => e.kind));
    expect(kinds.has("join")).toBe(true);
    expect(kinds.has("contains")).toBe(true);
    expect(kinds.has("invokes")).toBe(true);
    // a join edge crossing server -> web or server -> openapi exists
    const cross = s.graph.edges.some((e) => {
      if (e.kind !== "join") return false;
      const fa = s.graph.nodes[e.a]!.file;
      const fb = s.graph.nodes[e.b]!.file;
      return fa.split("/")[0] !== fb.split("/")[0];
    });
    expect(cross).toBe(true);
  });

  it("sketch silhouettes the repo with feature anchors first", () => {
    resetSessions();
    const r = sketch(FIXTURE, 900);
    expect(r.tokens).toBeLessThanOrEqual(900);
    expect(r.text).toContain("fovea sketch");
    expect(r.text).toContain("⚑ GET /api/users/{*}");
    expect(r.text).toMatch(/server\//);
    expect(r.text).toMatch(/web\//);
  });

  it("focus on a route resolves across languages within budget", () => {
    resetSessions();
    const r = focus(FIXTURE, "/api/users/{id}", 1600);
    expect(r.tokens).toBeLessThanOrEqual(1600);
    expect(r.text).toContain("server/main.go");
    expect(r.text).toContain("web/api.ts");
    expect(r.text).toContain("openapi.yaml");
  });

  it("focus on a symbol keeps signatures foveated and budgets", () => {
    for (const B of [400, 800, 1600, 4000]) {
      resetSessions(); // fresh eyes per budget: deltas otherwise show nothing new
      const r = focus(FIXTURE, "loadUser", B);
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
    resetSessions();
    const r = focus(FIXTURE, "loadUser", 4000);
    expect(r.text).toContain("▲"); // hot tier renders full signature lines
    expect(r.text).toContain("loadUser");
  });


  it("recovers equivalent camelCase and inflected symbol queries", () => {
    resetSessions();
    const plural = focus(FIXTURE, "loadsUsers", 1200);
    expect(Number(plural.details.seeds)).toBeGreaterThan(0);
    expect(plural.text).toContain("loadUser");

    resetSessions();
    const switchQuery = focus(FIXTURE, "switchServer", 1200);
    expect(Number(switchQuery.details.seeds)).toBeGreaterThan(0);
    expect(switchQuery.text).toContain("ClientConnection.switchingServers");
    expect(switchQuery.text).toContain("web/server-switcher.ts:2");
  });

  it("suggests nearby symbols when a typo cannot seed the graph", () => {
    resetSessions();
    const r = focus(FIXTURE, "loadUsr", 256);
    expect(r.tokens).toBeLessThanOrEqual(256);
    expect(r.details.seeds).toBe(0);
    expect(r.text).toContain("Nearby symbols:");
    expect(r.text).toContain("loadUser");
    expect(Array.isArray(r.details.suggestions)).toBe(true);
  });

  it("explains direct call relationships before the thermal periphery", () => {
    resetSessions();
    const r = focus(FIXTURE, "loadUser", 1600);
    expect(r.text).toContain("← caller");
    expect(r.text).toContain("GetUserHandler");
  });

  it("second identical focus returns a delta, not a repeat", () => {
    resetSessions();
    const a = focus(FIXTURE, "loadUser", 2000);
    const b = focus(FIXTURE, "loadUser", 2000);
    expect(Number(b.details.suppressed)).toBeGreaterThan(0);
    expect(b.text).toContain("seen");
    // delta shares no hot signature line with the first answer
    const hotA = a.text.split("\n").filter((l) => l.startsWith("▲"));
    for (const line of hotA) expect(b.text).not.toContain(line);
  });

  it("dwell deepens the field and reports the t transition", () => {
    resetSessions();
    focus(FIXTURE, "loadUser", 800);
    const d = dwell(FIXTURE, 2, 1600);
    expect(d.tokens).toBeLessThanOrEqual(1600);
    expect(d.text).toContain("dwell");
    expect(d.text).toMatch(/t 2(\.\d+)?→4/);
    expect(Number(d.details.to)).toBe(4);
  });

  it("impact warms the client and spec when the Go handler file is edited", () => {
    resetSessions();
    const r = impact(FIXTURE, { files: ["server/users.go"], includeUncommitted: false, budget: 2000 });
    expect(r.tokens).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("fovea impact");
    expect(r.text).toContain("web/api.ts");      // shares the /api/users literal
    expect(r.text).toContain("openapi.yaml");    // same route in the spec
    expect(r.text).toContain("worker/search.rs"); // same route literal in Rust
    // the seed file's own symbols are not part of the review list
    expect(r.text.split("\n").filter((l) => l.startsWith("server/users.go"))).toHaveLength(0);
  });

  it("budgets are hard even with hundreds of lit nodes (min clamp)", () => {
    resetSessions();
    for (const B of [256, 300, 400, 600]) {
      const r = focus(FIXTURE, "users", B); // broad substring: lights most of the graph
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
  });

  it("impact with unknown files guides instead of crashing", () => {
    const r = impact(FIXTURE, { files: ["nope/nothing.ts"], includeUncommitted: false });
    expect(r.text).toContain("no seed files");
  });
});
