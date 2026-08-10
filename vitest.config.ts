import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    // Sync tests chain many verdicts (fresh ast-grep + graph rebuild each);
    // under tsc/vitest overlap a 30s bound made whole files flake-skip.
    testTimeout: 90000,
    hookTimeout: 90000,
    include: ["tests/*.test.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**"],
  },
});
