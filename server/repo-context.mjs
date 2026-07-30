// ── Repo-context loader (symposion-I63) ────────────────────────────────────
// Walks up from `cwd` collecting EVERY AGENTS.md (or CLAUDE.md) on the way to
// the filesystem root, and returns them concatenated root-first — the same
// resolution Claude Code performs for its own instruction files. Caches by
// (path, mtime). Extracted into its own module so unit tests can import it
// without pulling in the entire Express server startup (app.listen, etc.).
//
// WHY CONCATENATE RATHER THAN TAKE THE NEAREST. This used to return the first
// file found and stop, so a repo-level AGENTS.md REPLACED the fleet-level one
// instead of supplementing it — adding a small repo file silently shrank a
// persona's context from ~30KB of fleet conventions to whatever that file
// said. Claude Code concatenates every level, so the same repo produced
// different context depending on which backend read it, while
// context-delivery-policy.md §6 asserted the two behaved identically.
// Mirrors nousergon_lib.context.load_repo_context — the two are a contract
// pair and must not drift.

import fs from "node:fs";
import path from "node:path";

const MAX_CONTEXT_WALK_DEPTH = 8;
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

/** @type {Map<string, {mtimeMs: number, content: string}>} */
const contextCache = new Map();

/**
 * Read one instruction file from `dir` through the (path, mtime) cache.
 *
 * `dir` is user-influenced: `cwd` reaches this module from
 * `POST /api/personas` (`workspaceDir`). The FILENAME is not — `nameIndex`
 * selects from the module-level literal list, so the read target is
 * `<some directory>/AGENTS.md` or `<some directory>/CLAUDE.md` and can never
 * be steered at a file of the caller's choosing.
 *
 * Taking an index rather than a joined path is deliberate. An earlier version
 * accepted the full path and validated its basename afterwards; CodeQL
 * correctly kept flagging that as path injection, because a check performed
 * after the string is built is a check that can be bypassed by construction.
 * Building the path here from a literal removes the taint at the source
 * instead of asserting it away.
 *
 * @param {string} dir
 * @param {number} nameIndex - index into CONTEXT_FILE_CANDIDATES
 * @returns {string|null}
 */
function readCached(dir, nameIndex) {
  const name = nameIndex === 0 ? "AGENTS.md" : "CLAUDE.md";
  const resolved = path.join(path.resolve(dir), name);
  try {
    const stat = fs.statSync(resolved);                  // throws if missing
    const cached = contextCache.get(resolved);
    const mtimeMs = stat.mtimeMs;
    if (cached && cached.mtimeMs === mtimeMs) return cached.content;

    const content = fs.readFileSync(resolved, "utf-8");
    contextCache.set(resolved, { mtimeMs, content });
    return content;
  } catch {
    return null;                                         // ENOENT / EACCES
  }
}

/**
 * @param {string} cwd - absolute path to start the upward walk from
 * @returns {string|null} every instruction file from cwd to root, joined
 *   root-first, or null if none exists anywhere up the tree
 */
export function loadRepoContext(cwd) {
  /** @type {Array<[string, string]>} */
  const sections = [];
  let dir = cwd;

  for (let i = 0; i < MAX_CONTEXT_WALK_DEPTH; i++) {
    for (let n = 0; n < CONTEXT_FILE_CANDIDATES.length; n++) {
      const content = readCached(dir, n);
      if (content !== null) {
        sections.push([path.join(dir, CONTEXT_FILE_CANDIDATES[n]), content]);
        break;   // one file per directory — CLAUDE.md is usually a symlink
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;                           // filesystem root
    dir = parent;
  }

  if (sections.length === 0) return null;

  // Collected nearest-first; emit root-first so specificity increases and the
  // most specific instruction is the last thing the model reads.
  sections.reverse();

  if (sections.length === 1) return sections[0][1];

  return sections
    .map(([p, content]) => `── Repository context: ${p} ──\n\n${content}`)
    .join("\n\n");
}

// Exported for unit-test visibility only — not part of the public API surface.
export const _test = { loadRepoContext, contextCache, MAX_CONTEXT_WALK_DEPTH, CONTEXT_FILE_CANDIDATES };
