import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceDir, isWorkspaceAllowed, workspaceRoots, workspaceRejectionMessage, DEV_ROOT } from "./workspace.mjs";

// symposion-I110 / CodeQL js/path-injection #42-#44. `workspaceDir` arrives
// from the request body and flows into `git worktree add -b` with `cwd` set to
// it, so an unconstrained value lets POST /api/personas create a branch in any
// repo on the machine. The old resolver called path.resolve and stopped there
// - normalising is not constraining.

test("the default root is ~/Development", () => {
  assert.deepEqual(workspaceRoots({}), [DEV_ROOT]);
});

test("roots are overridable, so widening never needs a code change", () => {
  // A guard that can only be relaxed by editing source gets relaxed by
  // deleting it.
  const roots = workspaceRoots({ SYMPOSION_WORKSPACE_ROOTS: "/srv/code:~/Other" });
  assert.deepEqual(roots, ["/srv/code", path.join(os.homedir(), "Other")]);
});

test("an empty or blank override falls back to the default rather than allowing everything", () => {
  // The dangerous failure is an override that parses to zero roots and is
  // then read as "no restriction".
  assert.deepEqual(workspaceRoots({ SYMPOSION_WORKSPACE_ROOTS: "" }), [DEV_ROOT]);
  assert.deepEqual(workspaceRoots({ SYMPOSION_WORKSPACE_ROOTS: "   :  " }), [DEV_ROOT]);
});

test("a path inside a root is allowed", () => {
  assert.equal(isWorkspaceAllowed(path.join(DEV_ROOT, "symposion"), [DEV_ROOT]), true);
  assert.equal(isWorkspaceAllowed(DEV_ROOT, [DEV_ROOT]), true, "the root itself must be allowed");
});

test("a path outside every root is refused", () => {
  for (const bad of ["/etc", "/", "/tmp/evil", os.homedir()]) {
    assert.equal(isWorkspaceAllowed(bad, [DEV_ROOT]), false, `${bad} was allowed`);
  }
});

test("traversal out of a root is refused", () => {
  assert.equal(isWorkspaceAllowed(path.join(DEV_ROOT, "..", "..", "etc"), [DEV_ROOT]), false);
  assert.equal(isWorkspaceAllowed(`${DEV_ROOT}/../.ssh`, [DEV_ROOT]), false);
});

test("a sibling whose name merely STARTS WITH the root is refused", () => {
  // The classic off-by-one: startsWith without the separator lets
  // /Users/x/Development-evil pass as being under /Users/x/Development.
  assert.equal(isWorkspaceAllowed(`${DEV_ROOT}-evil`, [DEV_ROOT]), false);
  assert.equal(isWorkspaceAllowed(`${DEV_ROOT}xyz/repo`, [DEV_ROOT]), false);
});

test("a symlink pointing OUT of a root is refused, not just its name checked", () => {
  // This is why containment resolves real paths. A name-only check tests
  // where the path is spelled, not where git would actually operate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposion-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "symposion-outside-"));
  try {
    const link = path.join(root, "escape");
    fs.symlinkSync(outside, link);
    assert.equal(isWorkspaceAllowed(link, [root]), false, "a symlink out of the root was allowed");
    // And a real directory inside it still is.
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    assert.equal(isWorkspaceAllowed(real, [root]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a path that does not exist yet still resolves and is judged", () => {
  // realpath throws on a missing path; the resolver walks up to the deepest
  // existing ancestor so a not-yet-created workspace is still checkable.
  assert.equal(isWorkspaceAllowed(path.join(DEV_ROOT, "does-not-exist-yet", "deep"), [DEV_ROOT]), true);
  assert.equal(isWorkspaceAllowed("/nonexistent-root/deep", [DEV_ROOT]), false);
});

// These two deliberately do NOT reference ~/Development. An earlier version
// asserted against `fs.realpathSync(DEV_ROOT)`, which passes on a machine that
// happens to have that directory and fails everywhere else — CI caught it. The
// home directory is the only path that can be assumed to exist.
test("~ expands the way a shell would, since people type it that way", () => {
  const home = fs.realpathSync(os.homedir());
  assert.equal(resolveWorkspaceDir("~/nonexistent-xyz"), path.join(home, "nonexistent-xyz"));
});

test("an absent value falls back to the supplied default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposion-fallback-"));
  try {
    const expected = fs.realpathSync(dir);
    assert.equal(resolveWorkspaceDir(null, dir), expected);
    assert.equal(resolveWorkspaceDir("", dir), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the default root resolves even when ~/Development does not exist", () => {
  // The production default is ~/Development; it must not depend on that
  // directory already existing, or a fresh machine would refuse every
  // workspace including the one it is about to create.
  assert.equal(isWorkspaceAllowed(path.join(DEV_ROOT, "some-repo"), [DEV_ROOT]), true);
});

test("the rejection message names what was refused AND how to widen it", () => {
  // A refusal that does not say how to proceed gets worked around rather than
  // understood.
  const msg = workspaceRejectionMessage("/etc", [DEV_ROOT]);
  assert.match(msg, /\/etc/);
  assert.match(msg, new RegExp(DEV_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(msg, /SYMPOSION_WORKSPACE_ROOTS/);
});
