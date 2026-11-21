import { resolve } from "path";
import { defineConfig } from "vitest/config";
import { webBuildEnv } from "./scripts/release-public.mjs";

export default defineConfig({
  test: {
    setupFiles: ["src/tests/setup.ts"],
    // The same public release projection next.config.ts inlines.
    env: webBuildEnv(),
    testTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.test.tsx"],
          environment: "happy-dom",
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Match Next's server-component test environment without removing the
      // production import guard from server-only modules.
      "server-only": resolve(
        __dirname,
        "node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
});
