import eslint from "@eslint/js";
import { dirname } from "path";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.wrangler/**",
      "**/out/**",
      "**/deploy/**",
      // Rebuilt from the linted encryption package; includes third-party code.
      "apps/scripts/src/support-agent/own-encryption.mjs",
      // Evidence-only records of retired contract releases; never linted.
      "packages/evm/legacy-records/**",
      // Foundry dependencies and build output.
      "packages/evm/contracts-v4/dependencies/**",
      "packages/evm/contracts-v4/cache/**",
    ],
  },
  // Base JS recommended
  eslint.configs.recommended,
  // TS recommended (non-type-aware for speed and simplicity)
  ...tseslint.configs.recommended,
  {
    files: ["apps/workers/community/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@templ/e2ee/client",
                "@templ/e2ee/customer",
                "@templ/e2ee/own-authority",
                "@templ/e2ee/backup",
                "@templ/e2ee/device-store",
                "@templ/e2ee/transport",
                "@templ/e2ee/view",
                "**/e2ee/src/*",
              ],
              message:
                "Customer message keys and decryption code must stay on customer-controlled infrastructure. Templ runtimes may import only @templ/e2ee/protocol, /verify and /relay.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/scripts/src/release/**/*.mjs",
      "apps/scripts/src/support-agent/**/*.mjs",
      "apps/workers/community/scripts/*.mjs",
    ],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        structuredClone: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,js,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Minimal, pragmatic rules; formatting is handled by Prettier
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
];
