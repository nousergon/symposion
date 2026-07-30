import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitRepo, createIsolatedWorktree, removeWorktreeAndBranch } from "./worktree.mjs";

// Exercised against a REAL throwaway git repo rather than a mocked
// execFileSync: the thing under test is what git actually does to a working
// tree, and a mock would assert only that we typed the arguments we typed.
// symposion-policy.md T0-4 is about a mutation of Brian's real checkout, so
// the test performs a real mutation of a real (temporary) checkout.

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposion-wt-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return { dir, git };
}

/** Capture console.log/error for the duration of `fn`. */
function capture(fn) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    return { result: fn(), out, err };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** Parse one `key="value"` audit line into an object. */
function parseAudit(line) {
  const fields = {};
  for (const [, k, v] of line.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
    fields[k] = JSON.parse(`"${v}"`);
  }
  return fields;
}

function cleanup(repo, wt) {
  try {
    if (wt) execFileSync("git", ["worktree", "remove", wt, "--force"], { cwd: repo.dir, stdio: "ignore" });
  } catch { /* already gone */ }
  fs.rmSync(repo.dir, { recursive: true, force: true });
}

test("isGitRepo distinguishes a repo from a plain directory", () => {
  const repo = tempRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "symposion-plain-"));
  try {
    assert.equal(isGitRepo(repo.dir), true);
    assert.equal(isGitRepo(plain), false);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("creating a worktree really creates one, and records the mutation", () => {
  const repo = tempRepo();
  let wt;
  try {
    const { result, out } = capture(() =>
      createIsolatedWorktree(repo.dir, "Propus", "06f6ce1b-eec7-4d53-b95d-0a61811e349f", "persona created (claude-code)"),
    );
    wt = result.worktreePath;

    // The mutation actually happened.
    assert.ok(fs.existsSync(result.worktreePath), "worktree directory was not created");
    const branches = execFileSync("git", ["branch", "--list", result.branch], { cwd: repo.dir }).toString();
    assert.match(branches, /symposion\/propus-06f6ce1b/);

    // And it was recorded. This is the T0-4 requirement: before this change a
    // successful create emitted nothing at all.
    const line = out.find((l) => l.startsWith("[worktree] created"));
    assert.ok(line, "a successful worktree creation emitted no audit record");
    const f = parseAudit(line);
    assert.equal(f.branch, result.branch);
    assert.equal(f.path, result.worktreePath);
    assert.equal(f.repo, repo.dir);
    assert.match(f.persona, /Propus \(06f6ce1b-/, "the acting persona must be named");
    assert.equal(f.reason, "persona created (claude-code)");
    assert.match(f.head, /^[0-9a-f]{40}$/, "the base commit must be recorded");
  } finally {
    cleanup(repo, wt);
  }
});

test("teardown really removes both, and records who and why", () => {
  const repo = tempRepo();
  let wt;
  try {
    const created = createIsolatedWorktree(repo.dir, "Zibal", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "persona created");
    wt = created.worktreePath;

    const { out } = capture(() =>
      removeWorktreeAndBranch(repo.dir, created.worktreePath, created.branch, {
        personaId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        personaName: "Zibal",
        reason: "persona deleted (claude-code)",
      }),
    );

    assert.equal(fs.existsSync(created.worktreePath), false, "worktree was not removed");
    const branches = execFileSync("git", ["branch", "--list", created.branch], { cwd: repo.dir }).toString().trim();
    assert.equal(branches, "", "branch was not deleted");

    const line = out.find((l) => l.startsWith("[worktree] teardown"));
    assert.ok(line, "a successful teardown emitted no audit record");
    const f = parseAudit(line);
    assert.equal(f.worktree, "removed");
    assert.equal(f.branchDelete, "deleted");
    // The persona is gone by now - which is exactly why its identity has to be
    // in this line rather than looked up afterwards.
    assert.match(f.persona, /Zibal \(aaaaaaaa-/);
    assert.equal(f.reason, "persona deleted (claude-code)");
    wt = null;
  } finally {
    cleanup(repo, wt);
  }
});

test("a PARTIAL teardown is recorded as partial, not as success", () => {
  const repo = tempRepo();
  let wt;
  try {
    const created = createIsolatedWorktree(repo.dir, "Mizar", "11111111-2222-3333-4444-555555555555", "persona created");
    wt = created.worktreePath;

    // Remove the worktree out from under it, so the worktree step fails while
    // the branch delete still succeeds. An orphan of this shape needs a human,
    // and it is indistinguishable from clean success unless both are stated.
    execFileSync("git", ["worktree", "remove", created.worktreePath, "--force"], { cwd: repo.dir });
    wt = null;

    const { out, err } = capture(() =>
      removeWorktreeAndBranch(repo.dir, created.worktreePath, created.branch, {
        personaId: "11111111-2222-3333-4444-555555555555",
        personaName: "Mizar",
        reason: "persona deleted (api)",
      }),
    );

    const f = parseAudit(out.find((l) => l.startsWith("[worktree] teardown")));
    assert.match(f.worktree, /^FAILED/, "a failed worktree removal was recorded as success");
    assert.equal(f.branchDelete, "deleted");
    assert.ok(err.some((l) => l.includes("failed to remove worktree")), "the failure must still raise on stderr");
  } finally {
    cleanup(repo, wt);
  }
});

test("teardown never throws - a delete must still succeed when git cleanup cannot", () => {
  const repo = tempRepo();
  try {
    const { out } = capture(() =>
      removeWorktreeAndBranch(repo.dir, "/nonexistent/path", "symposion/never-existed", {
        personaId: "x",
        personaName: "Ghost",
        reason: "persona deleted",
      }),
    );
    const f = parseAudit(out.find((l) => l.startsWith("[worktree] teardown")));
    assert.match(f.worktree, /^FAILED/);
    assert.match(f.branchDelete, /^FAILED/);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an orphaned worktree is traceable to its persona and reason from the log alone", () => {
  // The T0-4 acceptance case end to end: given only the audit lines, a
  // directory left behind in the worktree root can be attributed after the
  // persona that made it no longer exists.
  const repo = tempRepo();
  let wt;
  try {
    const { result, out } = capture(() =>
      createIsolatedWorktree(repo.dir, "Orphan", "deadbeef-0000-0000-0000-000000000000", "persona created (api)"),
    );
    wt = result.worktreePath;

    const auditLines = out.filter((l) => l.startsWith("[worktree]"));
    const owner = auditLines.map(parseAudit).find((f) => f.path === result.worktreePath);
    assert.ok(owner, "the orphan's path appears in no audit line");
    assert.match(owner.persona, /Orphan \(deadbeef-/);
    assert.equal(owner.reason, "persona created (api)");
  } finally {
    cleanup(repo, wt);
  }
});
