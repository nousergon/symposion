import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a persona's workspace is allowed to be.
 *
 * `workspaceDir` arrives from the request body and flows into
 * `createIsolatedWorktree()`, which runs `git worktree add -b` with `cwd` set
 * to it — so an unconstrained value means POST /api/personas can create a
 * branch and a worktree in ANY git repo on the machine, and run `git` with an
 * arbitrary working directory. CodeQL flagged the three execFileSync sinks in
 * server/worktree.mjs as `js/path-injection` (alerts #42/#43/#44, high);
 * symposion-I110 is the record.
 *
 * The previous resolver normalised (`path.resolve`) but never constrained,
 * and normalising is not constraining — `/etc` resolves perfectly well.
 *
 * What made this survivable rather than urgent is symposion-policy.md §3
 * condition C1: loopback bind, one local user, no auth — reaching it needs
 * local code execution, at which point running `git` directly is easier. It
 * stops being survivable the moment §6 exit trigger E1 fires (any bind beyond
 * 127.0.0.1), which is why this is fixed now rather than deferred into the
 * pile of things E1 would demand all at once.
 */

const DEV_ROOT = path.join(os.homedir(), "Development");

/**
 * Roots a workspace may live under. Overridable so widening never requires a
 * code change — a guard that can only be relaxed by editing source gets
 * relaxed by deleting it.
 */
export function workspaceRoots(env = process.env) {
  const raw = env.SYMPOSION_WORKSPACE_ROOTS;
  if (!raw) return [DEV_ROOT];
  const roots = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => expandHome(s))
    .map((s) => path.resolve(s));
  return roots.length ? roots : [DEV_ROOT];
}

function expandHome(raw) {
  return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}

/**
 * Resolve the deepest EXISTING ancestor's real path, then re-append the rest.
 *
 * Plain `path.resolve` leaves symlinks intact, so a symlink sitting inside an
 * allowed root but pointing outside it would pass a containment check while
 * git operated somewhere else entirely — the containment check would be
 * testing a name rather than a location. `fs.realpathSync` throws on a path
 * that does not exist yet, hence walking up to the first component that does.
 */
function realResolve(target) {
  let current = path.resolve(target);
  const trailing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(target);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Expand `~`, resolve to an absolute real path. Does NOT authorize it. */
export function resolveWorkspaceDir(raw, fallback = DEV_ROOT) {
  if (!raw) return realResolve(fallback);
  return realResolve(expandHome(String(raw)));
}

/**
 * Is `dir` inside one of `roots`?
 *
 * Compares resolved real paths with a separator-terminated prefix, so
 * `/Users/x/Development-evil` cannot pass as being under
 * `/Users/x/Development` — the classic off-by-one in this check.
 */
export function isWorkspaceAllowed(dir, roots = workspaceRoots()) {
  const resolved = realResolve(dir);
  return roots.some((root) => {
    const base = realResolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

/** A message naming what was refused and how to widen it deliberately. */
export function workspaceRejectionMessage(dir, roots = workspaceRoots()) {
  return (
    `workspaceDir must be inside one of: ${roots.join(", ")} (got ${realResolve(dir)}). ` +
    `Set SYMPOSION_WORKSPACE_ROOTS to widen this.`
  );
}

export { DEV_ROOT };
