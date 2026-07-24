const js = require("@eslint/js");

module.exports = [
  // Ignore vendored / generated / non-project files
  {
    ignores: [
      "public/vendor/**",
      "data/**",
      "node_modules/**",
    ],
  },

  // Server-side .mjs files — ES modules, Node.js globals
  {
    files: ["server/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Node.js built-in globals
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        TextDecoder: "readonly",
        EventEmitter: "readonly",
        Atomics: "readonly",
        SharedArrayBuffer: "readonly",
      },
    },
    rules: {
      // Allow console.log/error/warn in server code — legitimate logging
      "no-console": "off",
      // Allow leading underscore for "private" properties
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Client-side JavaScript — browser globals, script mode
  {
    files: ["public/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        // Browser
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        history: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Request: "readonly",
        Response: "readonly",
        // DOM
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLImageElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLFormElement: "readonly",
        HTMLAnchorElement: "readonly",
        HTMLSpanElement: "readonly",
        HTMLUListElement: "readonly",
        HTMLLIElement: "readonly",
        CustomEvent: "readonly",
        EventSource: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
        ResizeObserver: "readonly",
        // Event
        Event: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        FocusEvent: "readonly",
        InputEvent: "readonly",
        TouchEvent: "readonly",
        // Timers
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        // Other
        console: "readonly",
        Math: "readonly",
        Date: "readonly",
        JSON: "readonly",
        RegExp: "readonly",
        Map: "readonly",
        Set: "readonly",
        WeakMap: "readonly",
        Promise: "readonly",
        String: "readonly",
        Number: "readonly",
        Boolean: "readonly",
        Array: "readonly",
        Object: "readonly",
        Error: "readonly",
        TypeError: "readonly",
        parseInt: "readonly",
        parseFloat: "readonly",
        isNaN: "readonly",
        encodeURIComponent: "readonly",
        decodeURIComponent: "readonly",
        btoa: "readonly",
        atob: "readonly",
        structuredClone: "readonly",
        // Notification API
        Notification: "readonly",
        // Push API
        PushSubscription: "readonly",
        PushManager: "readonly",
        PushSubscriptionOptions: "readonly",
        ServiceWorkerRegistration: "readonly",
        // Service Worker
        self: "readonly",
        addEventListener: "readonly",
        skipWaiting: "readonly",
        clients: "readonly",
        // Focus / Fullscreen
        console: "readonly",
        Text: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        BigInt: "readonly",
        FormData: "readonly",
        File: "readonly",
        Blob: "readonly",
        // Promise-based
        crypto: "readonly",
        SubtleCrypto: "readonly",
        // Notification
        Image: "readonly",
        Audio: "readonly",
        // Iteration
        Symbol: "readonly",
        Reflect: "readonly",
        Proxy: "readonly",
        // WebSocket
        WebSocket: "readonly",
        // ES2023
        ArrayBuffer: "readonly",
        Uint8Array: "readonly",
        Int32Array: "readonly",
        DataView: "readonly",
        DOMException: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Allow assignments to window properties for global state
      "no-global-assign": ["error", { exceptions: ["location", "Notification"] }],
    },
  },
];
