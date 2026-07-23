// ── Repo-context loader (symposion-I63) ────────────────────────────────────
// Walks up from `cwd` looking for AGENTS.md (preferred) or CLAUDE.md
// (fallback), caching by (path, mtime). Extracted into its own module so unit
// tests can import it without pulling in the entire Express server startup
// (app.listen, egress-proxy spawn, etc.).

import fs from "node:fs";
import path from "node:path";

const MAX_CONTEXT_WALK_DEPTH = 8;
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

/** @type {Map<string, {mtimeMs: number, content: string}>} */
const contextCache = new Map();

/**
 * @param {string} cwd - absolute path to start the upward walk from
 * @returns {string|null} file content, or null if nothing found
 */
export function loadRepoContext(cwd) {
  let dir = cwd;
  for (let i = 0; i < MAX_CONTEXT_WALK_DEPTH; i++) {
    for (const name of CONTEXT_FILE_CANDIDATES) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);             // throws if missing
        const cached = contextCache.get(candidate);
        const mtimeMs = stat.mtimeMs;
        if (cached && cached.mtimeMs === mtimeMs) return cached.content;

        const content = fs.readFileSync(candidate, "utf-8");
        contextCache.set(candidate, { mtimeMs, content });
        return content;
      } catch {
        // ENOENT / EACCES → try next candidate or parent dir
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;                           // filesystem root
    dir = parent;
  }
  return null;
}

// Exported for unit-test visibility only — not part of the public API surface.
export const _test = { loadRepoContext, contextCache, MAX_CONTEXT_WALK_DEPTH, CONTEXT_FILE_CANDIDATES };
