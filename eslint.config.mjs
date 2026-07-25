import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    // Server-side Node.js ESM files
    files: ["server/**/*.mjs", "spike_*.mjs", "verify_streaming.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // No empty catch blocks without a comment
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // Client-side browser files (classic scripts loaded via <script> tag,
    // not bundled — globals from CDN/vendor are listed explicitly)
    files: ["public/app.js", "public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Service Worker (SW-specific globals not in globals.browser)
        clients: "readonly",
        // Loaded via <script src="vendor/marked.js"> in index.html
        marked: "readonly",
        // Loaded via <script src="vendor/purify.min.js"> in index.html
        DOMPurify: "readonly",
      },
    },
    rules: {
      // The exitTriageMode wrapping pattern (save → reassign) is intentional
      "no-func-assign": "off",
    },
  },
  {
    // Global ignores
    ignores: [
      "public/vendor/",
      "node_modules/",
      "infra/",
      "data/",
    ],
  },
];
