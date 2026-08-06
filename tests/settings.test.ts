import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { openFoveaSettings } from "../src/ui/settings.js";

describe("Fovea settings", () => {
  it("renders and persists the Hybrid grep toggle", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-settings-"));
    const configPath = path.join(root, ".pi", "fovea.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ tools: { replaceGrep: false } }));
    const notify = vi.fn();
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const context = {
      mode: "tui",
      cwd: root,
      isProjectTrusted: () => true,
      ui: {
        notify,
        custom: async (factory: (...args: any[]) => any) => new Promise<void>((resolve) => {
          const component = factory(
            { requestRender: () => {} },
            theme,
            {},
            () => resolve(),
          );
          expect(component.render(100).join("\n")).toContain("Hybrid grep");
          for (let index = 0; index < 4; index++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          component.handleInput("\u001b");
        }),
      },
    } as unknown as ExtensionContext;

    try {
      const result = await openFoveaSettings(context);
      expect(result).toEqual({ grepRegistrationChanged: true });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        tools: { replaceGrep: true },
      });
      expect(notify).toHaveBeenCalledWith("Fovea settings saved.", "info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
