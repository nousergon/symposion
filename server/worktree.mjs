import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Mirrors Brian's own standing rule (concurrent-session worktree isolation):
// any Claude Code session operating in a shared local checkout must run in
// a dedicated worktree, not the shared working tree directly - concurrent
// sessions collide via global git state (a checkout/branch switch in one
// session can move HEAD out from under another). Symposion personas run
// concurrently with each other AND with Brian's own terminal sessions on
// the same repos, so this applies here just as much as anywhere else.

const WORKTREE_ROOT = path.join(os.homedir(), "Development", ".symposion-worktrees");

export function isGitRepo(dir) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Creates a dedicated worktree for a persona operating on `repoDir`, branched
 * from the repo's current HEAD commit (not the branch pointer, so it doesn't
 * collide with whatever branch is checked out in the shared working tree).
 * Returns the new worktree's absolute path and the branch name.
 */
export function createIsolatedWorktree(repoDir, personaName, personaId) {
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });

  const repoName = path.basename(repoDir);
  const shortId = personaId.slice(0, 8);
  const branch = `symposion/${slugify(personaName)}-${shortId}`;
  const worktreePath = path.join(WORKTREE_ROOT, `${repoName}__${slugify(personaName)}-${shortId}`);

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch, headSha], { cwd: repoDir });

  return { worktreePath, branch, sourceRepoDir: repoDir, sourceRepoName: repoName };
}

/** Full teardown: remove the worktree, then delete its branch. Best-effort -
 * logs and continues rather than throwing, since a delete action should
 * still succeed at removing the persona even if git cleanup hits a snag
 * (e.g. uncommitted changes left in the worktree). */
export function removeWorktreeAndBranch(repoDir, worktreePath, branch) {
  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoDir });
  } catch (err) {
    console.error(`[worktree] failed to remove worktree ${worktreePath}:`, err.message);
  }
  try {
    execFileSync("git", ["branch", "-D", branch], { cwd: repoDir });
  } catch (err) {
    console.error(`[worktree] failed to delete branch ${branch}:`, err.message);
  }
}
