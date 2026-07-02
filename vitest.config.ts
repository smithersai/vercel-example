import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig uses jsx:"preserve" for Next; vitest (vite 8 / oxc) needs the JSX actually
  // compiled, so force the automatic runtime for the test pipeline.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup-env.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Without include globs, files never imported by a test are invisible to the
      // thresholds — a new untested module would not move the gate. Measure the whole
      // deployable surface.
      include: ["src/**/*.ts", "app/**/*.ts", "app/**/*.tsx"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
