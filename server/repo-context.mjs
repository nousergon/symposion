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
 * Read one instruction file through the (path, mtime) cache.
 *
 * `cwd` reaches this module from `POST /api/personas` (`workspaceDir`), so the
 * path is user-influenced. The walk only ever targets a file named exactly
 * AGENTS.md or CLAUDE.md, but that constraint used to be implicit in the call
 * site — CodeQL flagged the reads as path injection once this was extracted
 * into its own function, and it was right to: the guarantee lived in the
 * caller, not in the code doing the read.
 *
 * Now enforced here. The basename must be one of the known candidates, so a
 * traversal component in `cwd` cannot steer the read at a file of the
 * attacker's choosing — the worst case is reading an AGENTS.md somewhere
 * unintended, which is the same class of thing the walk does by design.
 *
 * @returns {string|null}
 */
function readCached(candidate) {
  const resolved = path.resolve(candidate);
  if (!CONTEXT_FILE_CANDIDATES.includes(path.basename(resolved))) return null;
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
    for (const name of CONTEXT_FILE_CANDIDATES) {
      const candidate = path.join(dir, name);
      const content = readCached(candidate);
      if (content !== null) {
        sections.push([candidate, content]);
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
