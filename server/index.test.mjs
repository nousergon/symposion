import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _test } from "./repo-context.mjs";

const { loadRepoContext, contextCache, MAX_CONTEXT_WALK_DEPTH, CONTEXT_FILE_CANDIDATES } = _test;

// ── helpers ────────────────────────────────────────────────────────────────

/** @returns {string} a temp dir guaranteed empty, auto-cleaned after the test */
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "symposion-test-"));
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

// ── tests ──────────────────────────────────────────────────────────────────

test("returns null when no context file exists anywhere up the tree", () => {
  const dir = tmpdir();
  try {
    const result = loadRepoContext(dir);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finds AGENTS.md at cwd directly", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# Project rules\n\nBe thorough.");
    const result = loadRepoContext(dir);
    assert.ok(result);
    assert.match(result, /Project rules/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finds CLAUDE.md when AGENTS.md is absent", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "CLAUDE.md", "# Claude instructions\n\nUse SOTA approaches.");
    const result = loadRepoContext(dir);
    assert.ok(result);
    assert.match(result, /Claude instructions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prefers AGENTS.md when both exist at the same level", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# Canonical rules");
    writeFile(dir, "CLAUDE.md", "# Legacy rules");
    const result = loadRepoContext(dir);
    assert.ok(result);
    assert.match(result, /Canonical rules/);
    assert.doesNotMatch(result, /Legacy rules/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("walks up from a subdirectory to find the context file", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# Top-level rules");
    const subdir = path.join(dir, "deep", "nested", "folder");
    fs.mkdirSync(subdir, { recursive: true });
    const result = loadRepoContext(subdir);
    assert.ok(result);
    assert.match(result, /Top-level rules/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finds the nearest context file (closest to cwd wins)", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# root");
    const subdir = path.join(dir, "project");
    fs.mkdirSync(subdir, { recursive: true });
    writeFile(subdir, "AGENTS.md", "# project-specific rules");
    const result = loadRepoContext(subdir);
    assert.ok(result);
    assert.match(result, /project-specific rules/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stops at filesystem root (does not infinite-loop)", () => {
  // /tmp has no AGENTS.md or CLAUDE.md, so this walks all the way to / and
  // returns null without crashing.
  const result = loadRepoContext("/tmp");
  assert.equal(result, null); // safe — no context file at filesystem root
});

test("caches content when mtime is unchanged", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# cached rules");
    const first = loadRepoContext(dir);
    assert.ok(first);
    // Second call should return the cached copy (same mtime)
    const second = loadRepoContext(dir);
    assert.ok(second);
    // Cache entry exists and is identical
    const cacheKey = path.join(dir, "AGENTS.md");
    assert.ok(contextCache.has(cacheKey));
    assert.equal(contextCache.get(cacheKey).content, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshes cache when mtime changes", () => {
  const dir = tmpdir();
  try {
    writeFile(dir, "AGENTS.md", "# version 1");
    const first = loadRepoContext(dir);
    assert.match(first, /version 1/);

    // Write new content (different mtime) — tiny delay guarantees new mtime
    const cacheKey = path.join(dir, "AGENTS.md");
    const oldMtime = contextCache.get(cacheKey).mtimeMs;
    // Busy-wait until mtime actually advances (HFS+ resolution is 1s, APFS
    // is nanosecond but this test should work on either).
    while (true) {
      writeFile(dir, "AGENTS.md", "# version 2");
      const stat = fs.statSync(cacheKey);
      if (stat.mtimeMs !== oldMtime) break;
      // On a fast FS with coarse timestamps, force a tick
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    const second = loadRepoContext(dir);
    assert.match(second, /version 2/);
    assert.equal(contextCache.get(cacheKey).content, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped walk depth — does not go beyond MAX_CONTEXT_WALK_DEPTH", () => {
  // Put a context file just beyond the walk limit and confirm it is NOT found.
  const dir = tmpdir();
  try {
    // Build a chain deeper than MAX_CONTEXT_WALK_DEPTH
    let deep = dir;
    for (let i = 0; i < MAX_CONTEXT_WALK_DEPTH + 1; i++) {
      deep = path.join(deep, `level-${i}`);
      fs.mkdirSync(deep, { recursive: true });
    }
    // Put AGENTS.md at the deepest dir (beyond the walk limit from `dir`)
    writeFile(deep, "AGENTS.md", "# too deep");
    const result = loadRepoContext(dir);
    // Should NOT find it — walk stops at MAX_CONTEXT_WALK_DEPTH before
    // reaching `deep`
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
