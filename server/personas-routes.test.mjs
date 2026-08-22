import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersonasRouter } from "./routes/personas.mjs";
import { CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, CLAUDE_EFFORT_LEVELS, isValidClaudeModel } from "./claude-code-backend.mjs";
import { createIsolatedWorktree, removeWorktreeAndBranch } from "./worktree.mjs";

// ── test scaffolding ────────────────────────────────────────────────────
//
// server/index.mjs starts a server (app.listen) plus a raft of real
// singletons (OpenCodeServerPool, personas.json on disk) at MODULE IMPORT
// TIME, which is exactly why these four routes had 0% coverage before this
// split (symposion#39). server/routes/personas.mjs has none of that: it
// only exports createPersonasRouter, a plain factory. These tests build a
// throwaway Express app around it and hit it over real HTTP on an ephemeral
// loopback port with fetch() - no supertest dependency, matching this
// repo's zero-new-deps convention (AGENTS.md).

/** A workspace root confined to a scratch temp dir, never ~/Development -
 * per AGENTS.md's "point tests at a disposable scratch repo" gotcha. */
function scratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "symposion-routes-test-"));
}

function tempRepo(root) {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return dir;
}

/** Minimal, safe-by-default ctx: every side-effecting collaborator not
 * under test is a no-op stub, so a test only exercises what it names. */
function baseCtx(overrides = {}) {
  const personas = overrides.personas ?? new Map();
  return {
    personas,
    fs,
    path,
    resolveWorkspaceDir: (raw, fallback) => (raw ? path.resolve(String(raw).replace(/^~/, os.homedir())) : fallback),
    isWorkspaceAllowed: (dir) => dir.startsWith(overrides.allowedRoot ?? "/__nowhere__"),
    workspaceRejectionMessage: (dir) => `workspaceDir must be inside ${overrides.allowedRoot}: ${dir}`,
    DEFAULT_WORKSPACE: overrides.allowedRoot ?? "/__nowhere__",
    MODEL_GROUP_KEYS: ["low", "med", "high", "ultra"],
    resolveModelGroup: overrides.resolveModelGroup ?? (() => null),
    isValidClaudeModel,
    CLAUDE_MODELS,
    CLAUDE_PERMISSION_MODES,
    CLAUDE_EFFORT_LEVELS,
    createPersonaFromRecipe: overrides.createPersonaFromRecipe ?? (async () => { throw new Error("createPersonaFromRecipe should not be called in this test"); }),
    personaSummary: overrides.personaSummary ?? ((p) => ({ id: p.id, name: p.name, backend: p.backend })),
    randomStarName: overrides.randomStarName ?? (() => "Test-Persona"),
    stopRemoteControl: overrides.stopRemoteControl ?? (() => {}),
    removeWorktreeAndBranch: overrides.removeWorktreeAndBranch ?? removeWorktreeAndBranch,
    ensureConnected: overrides.ensureConnected ?? (async () => { throw new Error("ensureConnected should not be called in this test"); }),
    removeArchives: overrides.removeArchives ?? (() => {}),
    persistAll: overrides.persistAll ?? (() => {}),
    ...overrides.extra,
  };
}

/** Boots a real HTTP server for `router` on an ephemeral loopback port and
 * returns {baseUrl, close}. */
async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── GET /api/random-name ────────────────────────────────────────────────

test("GET /api/random-name returns a name not already in use", async () => {
  const personas = new Map([["p1", { name: "Sirius" }]]);
  let capturedExisting;
  const ctx = baseCtx({
    personas,
    randomStarName: (existing) => {
      capturedExisting = existing;
      return "Vega";
    },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/random-name`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "Vega");
    assert.deepEqual(capturedExisting, ["Sirius"]);
  } finally {
    await close();
  }
});

// ── GET /api/personas ────────────────────────────────────────────────────

test("GET /api/personas lists every persona through personaSummary", async () => {
  const personas = new Map([
    ["p1", { id: "p1", name: "Sirius", backend: "claude-code" }],
    ["p2", { id: "p2", name: "Vega", backend: "api" }],
  ]);
  const ctx = baseCtx({ personas });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((p) => p.name).sort(), ["Sirius", "Vega"]);
  } finally {
    await close();
  }
});

// ── POST /api/personas ───────────────────────────────────────────────────

test("POST /api/personas with an omitted name auto-assigns a random star name", async () => {
  const personas = new Map([["existing", { name: "Sirius" }]]);
  const root = scratchRoot();
  let recipeSeen;
  const ctx = baseCtx({
    personas,
    allowedRoot: root,
    randomStarName: (existing) => {
      assert.deepEqual(existing, ["Sirius"]);
      return "Vega";
    },
    createPersonaFromRecipe: async (recipe) => {
      recipeSeen = recipe;
      return { id: "new-id", name: recipe.name, backend: recipe.backend };
    },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelID: "claude-opus-5", workspaceDir: root }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, "Vega");
    assert.equal(recipeSeen.name, "Vega");
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas rejects a workspaceDir outside the allowed roots", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelID: "claude-opus-5", workspaceDir: "/etc" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /workspaceDir must be inside/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas rejects an invalid backend", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "smoke-signal", modelID: "claude-opus-5", workspaceDir: root }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /backend must be/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas rejects modelGroup on the claude-code backend (symposion-I96)", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelGroup: "med", workspaceDir: root }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /api-backend only/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas resolves a valid modelGroup on the api backend", async () => {
  const root = scratchRoot();
  let recipeSeen;
  const ctx = baseCtx({
    allowedRoot: root,
    resolveModelGroup: (group) => (group === "med" ? { providerID: "litellm", modelID: "med" } : null),
    createPersonaFromRecipe: async (recipe) => {
      recipeSeen = recipe;
      return { id: "new-id", name: recipe.name, backend: recipe.backend };
    },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "api", modelGroup: "med", name: "Rigel", workspaceDir: root }),
    });
    assert.equal(res.status, 201);
    assert.equal(recipeSeen.providerID, "litellm");
    assert.equal(recipeSeen.modelID, "med");
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas rejects an unrecognized claude-code modelID", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelID: "not-a-real-model", workspaceDir: root }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unrecognized claude-code modelID/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas requires providerID for backend=api", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "api", modelID: "med", workspaceDir: root }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /providerID is required/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas rejects a workspaceDir that does not exist", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({ allowedRoot: root });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelID: "claude-opus-5", workspaceDir: path.join(root, "nope") }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /does not exist/);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/personas surfaces createPersonaFromRecipe failures as 500", async () => {
  const root = scratchRoot();
  const ctx = baseCtx({
    allowedRoot: root,
    createPersonaFromRecipe: async () => {
      throw new Error("boom");
    },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  const originalConsoleError = console.error;
  console.error = () => {}; // this path deliberately logs - keep test output clean
  try {
    const res = await fetch(`${baseUrl}/api/personas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude-code", modelID: "claude-opus-5", workspaceDir: root }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /boom/);
  } finally {
    console.error = originalConsoleError;
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── DELETE /api/personas/:id ─────────────────────────────────────────────

test("DELETE /api/personas/:id 404s for an unknown id", async () => {
  const ctx = baseCtx();
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas/does-not-exist`, { method: "DELETE" });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// The worktree-cleanup path is the one most worth a real test: it is the
// only route in this file with a real filesystem side effect that must
// actually be undone, not merely stubbed away. Exercised against a REAL
// scratch git repo, same pattern as worktree.test.mjs, so the assertion is
// "the worktree and branch are really gone" rather than "the mock was
// called with the arguments we expected it to be called with".
test("DELETE /api/personas/:id really cleans up the worktree and branch it created (claude-code backend)", async () => {
  const root = scratchRoot();
  const repoDir = tempRepo(root);
  const created = createIsolatedWorktree(repoDir, "Cleanup-Target", "cccccccc-0000-0000-0000-000000000000", "test setup");
  assert.ok(fs.existsSync(created.worktreePath), "precondition: worktree exists before delete");

  let killed = false;
  const persona = {
    id: "target-persona",
    name: "Cleanup-Target",
    backend: "claude-code",
    isolated: true,
    workspaceDir: repoDir,
    actualCwd: created.worktreePath,
    worktreeBranch: created.branch,
    claudeSession: { kill: () => { killed = true; } },
  };
  const personas = new Map([[persona.id, persona]]);

  let archivesRemovedFor;
  let persisted = false;
  const ctx = baseCtx({
    personas,
    removeArchives: (id) => { archivesRemovedFor = id; },
    persistAll: () => { persisted = true; },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);

    // The route's own effects.
    assert.equal(killed, true, "the claude-code session was not killed");
    assert.equal(personas.has(persona.id), false, "the persona was not removed from the live map");
    assert.equal(archivesRemovedFor, persona.id);
    assert.equal(persisted, true, "the deletion was not persisted");

    // The worktree-cleanup path itself: really gone, not merely asked-for.
    assert.equal(fs.existsSync(created.worktreePath), false, "the worktree directory was left dangling");
    const branches = execFileSync("git", ["branch", "--list", created.branch], { cwd: repoDir }).toString().trim();
    assert.equal(branches, "", "the branch was left dangling");
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /api/personas/:id on a non-isolated persona does not touch the filesystem", async () => {
  const persona = {
    id: "plain-persona",
    name: "Plain",
    backend: "claude-code",
    isolated: false,
    workspaceDir: "/some/real/repo",
    claudeSession: { kill: () => {} },
  };
  const personas = new Map([[persona.id, persona]]);
  let removeWorktreeCalled = false;
  const ctx = baseCtx({
    personas,
    removeWorktreeAndBranch: () => { removeWorktreeCalled = true; },
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(removeWorktreeCalled, false, "cleanup ran for a persona that never created a worktree");
  } finally {
    await close();
  }
});

test("DELETE /api/personas/:id on an api-backend persona connects, deletes the OpenCode session, then cleans up its worktree", async () => {
  const root = scratchRoot();
  const repoDir = tempRepo(root);
  const created = createIsolatedWorktree(repoDir, "Api-Target", "dddddddd-0000-0000-0000-000000000000", "test setup");

  let sessionDeleted = false;
  const persona = {
    id: "api-persona",
    name: "Api-Target",
    backend: "api",
    isolated: true,
    workspaceDir: repoDir,
    actualCwd: created.worktreePath,
    worktreeBranch: created.branch,
    sessionID: "sess-1",
    opencodeEntry: {
      client: {
        session: {
          delete: async ({ path: p }) => {
            assert.equal(p.id, "sess-1");
            sessionDeleted = true;
          },
        },
      },
    },
  };
  const personas = new Map([[persona.id, persona]]);
  const ctx = baseCtx({
    personas,
    ensureConnected: async () => {}, // already connected in this test
  });
  const { baseUrl, close } = await listen(createPersonasRouter(ctx));
  try {
    const res = await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(sessionDeleted, true);
    assert.equal(fs.existsSync(created.worktreePath), false, "the worktree directory was left dangling");
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
