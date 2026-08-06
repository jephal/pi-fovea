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

describe("fovea config grep integration", () => {
  it("defaults to augment with a bounded append budget", () => {
    expect(DEFAULT_FOVEA_CONFIG.tools).toMatchObject({
      defaultBudget: 2000,
      grepMode: "augment",
      grepAugmentBudget: 512,
    });
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
    const { root, agentDir, cwd } = setup({ tools: { grepMode: "overwrite", grepAugmentBudget: 99999 } });
    try {
      const tools = loadFoveaConfig({ cwd, agentDir, projectTrusted: false }).tools;
      expect(tools.grepMode).toBe("augment");
      expect(tools.grepAugmentBudget).toBe(8192);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
