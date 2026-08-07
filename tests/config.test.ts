// Config parsing for the grep integration: defaults, the new grepMode
// enum, and migration from the legacy `replaceGrep` boolean (v0.10).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOVEA_CONFIG,
  globalFoveaConfigPath,
  loadFoveaConfig,
} from "../src/core/config.js";

const setup = (stored: unknown) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-config-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (stored !== undefined) {
    writeFileSync(globalFoveaConfigPath(agentDir), JSON.stringify(stored));
  }
  const cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return { root, agentDir, cwd };
};

describe("fovea config", () => {
  it("defaults sync to visible and every budget knob to 512", () => {
    expect(DEFAULT_FOVEA_CONFIG.sync).toMatchObject({ mode: "enabled", budget: 512 });
    expect(DEFAULT_FOVEA_CONFIG.tools).toMatchObject({
      defaultBudget: 512,
      grepMode: "augment",
      grepAugmentBudget: 512,
    });
  });

  it("migrates legacy sync enabled booleans and prefers an explicit mode", () => {
    for (const [enabled, mode] of [[true, "enabled"], [false, "disabled"]] as const) {
      const { root, agentDir, cwd } = setup({ sync: { enabled } });
      try {
        expect(loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).sync.mode).toBe(mode);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const { root, agentDir, cwd } = setup({ sync: { enabled: false, mode: "hidden" } });
    try {
      expect(loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).sync.mode).toBe("hidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy replaceGrep booleans to grep modes", () => {
    for (const [legacy, mode] of [[true, "replace"], [false, "off"]] as const) {
      const { root, agentDir, cwd } = setup({ tools: { replaceGrep: legacy } });
      try {
        expect(loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).tools.grepMode).toBe(mode);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("prefers an explicit grepMode over the legacy key", () => {
    const { root, agentDir, cwd } = setup({ tools: { replaceGrep: true, grepMode: "augment" } });
    try {
      expect(loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).tools.grepMode).toBe("augment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown modes and clamps the augment budget", () => {
    const { root, agentDir, cwd } = setup({
      sync: { mode: "invisible" },
      tools: { grepMode: "overwrite", grepAugmentBudget: 99999 },
    });
    try {
      const config = loadFoveaConfig({ cwd, agentDir, projectTrusted: false });
      expect(config.sync.mode).toBe("enabled");
      expect(config.tools.grepMode).toBe("augment");
      expect(config.tools.grepAugmentBudget).toBe(8192);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets FOVEA_TURN_SYNC=off override hidden mode", () => {
    const { root, agentDir, cwd } = setup({ sync: { mode: "hidden" } });
    const previous = process.env.FOVEA_TURN_SYNC;
    process.env.FOVEA_TURN_SYNC = "off";
    try {
      expect(loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).sync.mode).toBe("disabled");
    } finally {
      if (previous === undefined) delete process.env.FOVEA_TURN_SYNC;
      else process.env.FOVEA_TURN_SYNC = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
