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
 * The audit record for a repo mutation.
 *
 * symposion-policy.md T0-4 (Tier 0): "Worktree and branch creation are already
 * real mutations of Brian's working tree; which persona did it and why must be
 * recoverable after the fact."
 *
 * Before this, only FAILURES were logged. A successful `git worktree add -b`
 * and a successful `git branch -D --force` both left no record at all — and
 * the only trace of who owned a branch was `worktreeBranch` on the persona,
 * which deletion removes at the same moment it force-deletes the branch. So
 * the one case the rule exists for, reconstructing this after the fact, was
 * exactly the case with nothing to reconstruct from.
 *
 * Emitted on stdout (launchd's StandardOutPath, `~/Library/Logs/symposion.log`)
 * so `grep '\[worktree\]'` over ONE file returns a branch's whole lifecycle.
 * Failures additionally raise on stderr, preserving the previous behaviour —
 * the audit stream stays complete either way.
 *
 * Deliberately not a new persistence layer: `personas.json` is the state file
 * and symposion-policy.md §6 E4 governs when that changes. What T0-4 asks for
 * is a durable, correlatable record of the mutation, not a store.
 */
function auditWorktree(action, fields) {
  const rendered = Object.entries(fields)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v ?? ""))}`)
    .join(" ");
  console.log(`[worktree] ${action} ${rendered}`);
}

/**
 * Creates a dedicated worktree for a persona operating on `repoDir`, branched
 * from the repo's current HEAD commit (not the branch pointer, so it doesn't
 * collide with whatever branch is checked out in the shared working tree).
 * Returns the new worktree's absolute path and the branch name.
 *
 * @param {string} reason - why this mutation is happening, in the caller's own
 *   words. Passed in rather than assumed here: this module cannot know whether
 *   it was a persona creation, a recipe replay, or something added later, and
 *   a reason the code guesses is not a reason.
 */
export function createIsolatedWorktree(repoDir, personaName, personaId, reason = "unspecified") {
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });

  const repoName = path.basename(repoDir);
  const shortId = personaId.slice(0, 8);
  const branch = `symposion/${slugify(personaName)}-${shortId}`;
  const worktreePath = path.join(WORKTREE_ROOT, `${repoName}__${slugify(personaName)}-${shortId}`);

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch, headSha], { cwd: repoDir });

  auditWorktree("created", {
    branch,
    path: worktreePath,
    repo: repoDir,
    head: headSha,
    persona: `${personaName} (${personaId})`,
    reason,
  });

  return { worktreePath, branch, sourceRepoDir: repoDir, sourceRepoName: repoName };
}

/** Full teardown: remove the worktree, then delete its branch. Best-effort -
 * logs and continues rather than throwing, since a delete action should
 * still succeed at removing the persona even if git cleanup hits a snag
 * (e.g. uncommitted changes left in the worktree).
 *
 * Records the outcome of BOTH steps in one line, including the partial case:
 * "worktree removed but branch delete failed" is an orphan that needs a human,
 * and it is indistinguishable from full success unless both are stated.
 *
 * @param {{personaId?: string, personaName?: string, reason?: string}} context
 *   who and why, for the audit record - see auditWorktree(). The persona is
 *   about to stop existing, which is precisely why its identity has to be
 *   written down here rather than looked up later.
 */
export function removeWorktreeAndBranch(repoDir, worktreePath, branch, context = {}) {
  let worktreeOutcome = "removed";
  let branchOutcome = "deleted";

  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoDir });
  } catch (err) {
    worktreeOutcome = `FAILED (${err.message.split("\n")[0]})`;
    console.error(`[worktree] failed to remove worktree ${worktreePath}: ${err.message}`);
  }
  try {
    execFileSync("git", ["branch", "-D", branch], { cwd: repoDir });
  } catch (err) {
    branchOutcome = `FAILED (${err.message.split("\n")[0]})`;
    console.error(`[worktree] failed to delete branch ${branch}: ${err.message}`);
  }

  auditWorktree("teardown", {
    branch,
    path: worktreePath,
    repo: repoDir,
    worktree: worktreeOutcome,
    branchDelete: branchOutcome,
    persona: `${context.personaName ?? "unknown"} (${context.personaId ?? "unknown"})`,
    reason: context.reason ?? "unspecified",
  });
}
