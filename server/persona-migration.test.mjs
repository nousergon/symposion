import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migratePersonaToRouter,
  migratePersonas,
  repairClaudeCodeModel,
  repairLastRecipe,
  RETIRED_PROVIDER_IDS,
  LITELLM_PROVIDER_ID,
} from "./persona-migration.mjs";

const api = (over = {}) => ({
  id: "p1",
  name: "Vega",
  backend: "api",
  providerID: "deepseek",
  modelID: "deepseek-chat",
  workspaceDir: "/tmp/x",
  ...over,
});

// ── the cutover itself ─────────────────────────────────────────────────

test("a persona on a retired provider is repointed at the router", () => {
  const out = migratePersonaToRouter(api());
  assert.equal(out.providerID, LITELLM_PROVIDER_ID);
  assert.equal(out.modelID, "med");
  assert.equal(out.modelGroup, "med");
});

test("every retired provider id migrates", () => {
  for (const providerID of RETIRED_PROVIDER_IDS) {
    const out = migratePersonaToRouter(api({ providerID }));
    assert.equal(out.providerID, LITELLM_PROVIDER_ID, `${providerID} not migrated`);
  }
});

test("reasoning-tier models map to high, others to med", () => {
  const cases = [
    ["deepseek-reasoner", "high"],
    ["deepseek-v4-pro", "high"],
    ["grok-4-thinking", "high"],
    ["claude-opus-4-8", "high"],
    ["deepseek-chat", "med"],
    ["gemini-2.0-flash", "med"],
  ];
  for (const [modelID, expected] of cases) {
    assert.equal(migratePersonaToRouter(api({ modelID })).modelID, expected, modelID);
  }
});

test("a missing modelID does not throw and lands on med", () => {
  const out = migratePersonaToRouter(api({ modelID: undefined }));
  assert.equal(out.modelID, "med");
});

// ── what must NOT be touched ───────────────────────────────────────────

test("a persona already on the router is returned unchanged (identity)", () => {
  const p = api({ providerID: LITELLM_PROVIDER_ID, modelID: "ultra" });
  assert.equal(migratePersonaToRouter(p), p);
});

test("claude-code personas are untouched — different backend entirely", () => {
  const p = { id: "c1", backend: "claude-code", modelID: "claude-sonnet-5" };
  assert.equal(migratePersonaToRouter(p), p);
});

test("an unrelated api provider (opencode zen) is untouched", () => {
  const p = api({ providerID: "opencode", modelID: "grok-code" });
  assert.equal(migratePersonaToRouter(p), p);
});

test("migration preserves every other field", () => {
  const p = api({
    sessionID: "s-1",
    actualCwd: "/tmp/wt",
    permissionMode: "acceptEdits",
    effortLevel: "high",
    messages: [{ role: "user", text: "hi" }],
  });
  const out = migratePersonaToRouter(p);
  assert.equal(out.sessionID, "s-1");
  assert.equal(out.actualCwd, "/tmp/wt");
  assert.equal(out.permissionMode, "acceptEdits");
  assert.equal(out.effortLevel, "high");
  assert.deepEqual(out.messages, [{ role: "user", text: "hi" }]);
});

test("migration does not mutate the input record", () => {
  const p = api();
  migratePersonaToRouter(p);
  assert.equal(p.providerID, "deepseek");
  assert.equal(p.modelID, "deepseek-chat");
});

// ── batch behaviour ────────────────────────────────────────────────────

test("migratePersonas counts only records it actually changed", () => {
  const { records, migrated } = migratePersonas([
    api({ id: "a" }),
    api({ id: "b", providerID: LITELLM_PROVIDER_ID, modelID: "low" }),
    { id: "c", backend: "claude-code", modelID: "claude-sonnet-5" },
    api({ id: "d", providerID: "xai", modelID: "grok-4" }),
  ]);
  assert.equal(migrated, 2);
  assert.equal(records.length, 4);
  assert.equal(records[1].modelID, "low");
  assert.equal(records[2].backend, "claude-code");
});

test("an empty list is a no-op", () => {
  const { records, migrated } = migratePersonas([]);
  assert.equal(migrated, 0);
  assert.deepEqual(records, []);
});

test("a second run is idempotent — nothing left to migrate", () => {
  const first = migratePersonas([api({ id: "a" }), api({ id: "b", providerID: "gemini" })]);
  assert.equal(first.migrated, 2);
  const second = migratePersonas(first.records);
  assert.equal(second.migrated, 0);
});

// ── claude-code personas created with a capability class (symposion-I96) ──
//
// The New Agent modal hid its tier dropdown for claude-code but never cleared
// its value, and the create handler read that value regardless of backend. The
// resulting personas were persisted with modelID "high" and answered every
// turn with a 404 rendered as an assistant reply.

const cc = (over = {}) => ({
  id: "z1",
  name: "Zibal",
  backend: "claude-code",
  modelID: "claude-sonnet-5",
  workspaceDir: "/tmp/x",
  ...over,
});

test("a claude-code persona on a capability class is reset to the concrete default", () => {
  const out = repairClaudeCodeModel(cc({ modelID: "high", modelGroup: "high" }), "claude-opus-5");
  assert.equal(out.modelID, "claude-opus-5");
  assert.equal(out.modelGroup, null);
});

test("every capability class is repaired, not just the one that was hit", () => {
  for (const group of ["low", "med", "high", "ultra"]) {
    const out = repairClaudeCodeModel(cc({ modelID: group, modelGroup: group }), "claude-opus-5");
    assert.equal(out.modelID, "claude-opus-5", `${group} not repaired`);
  }
});

test("a claude-code persona on a valid model but carrying a group keeps its model, loses the group", () => {
  const out = repairClaudeCodeModel(cc({ modelID: "claude-haiku-4-5", modelGroup: "low" }), "claude-opus-5");
  assert.equal(out.modelID, "claude-haiku-4-5");
  assert.equal(out.modelGroup, null);
});

test("a healthy claude-code persona is returned untouched (identity preserved)", () => {
  const rec = cc();
  assert.equal(repairClaudeCodeModel(rec, "claude-opus-5"), rec);
});

test("an api persona is never touched by the claude-code repair — class addressing is correct there", () => {
  const rec = api({ providerID: LITELLM_PROVIDER_ID, modelID: "high", modelGroup: "high" });
  assert.equal(repairClaudeCodeModel(rec, "claude-opus-5"), rec);
});

test("migratePersonas repairs claude-code records alongside the router migration", () => {
  const { records, migrated } = migratePersonas([
    cc({ id: "a", modelID: "high", modelGroup: "high" }),
    cc({ id: "b" }),
    api({ id: "c", providerID: "xai", modelID: "grok-4" }),
  ], LITELLM_PROVIDER_ID, "claude-opus-5");
  assert.equal(migrated, 2);
  assert.equal(records[0].modelID, "claude-opus-5");
  assert.equal(records[1].modelID, "claude-sonnet-5");
  assert.equal(records[2].providerID, LITELLM_PROVIDER_ID);
});

test("the claude-code repair is idempotent", () => {
  const first = migratePersonas([cc({ modelID: "high", modelGroup: "high" })], LITELLM_PROVIDER_ID, "claude-opus-5");
  assert.equal(first.migrated, 1);
  assert.equal(migratePersonas(first.records, LITELLM_PROVIDER_ID, "claude-opus-5").migrated, 0);
});

// ── lastRecipe, which is what made this defect self-propagating ─────────

test("a lastRecipe naming a class on claude-code is reset to a concrete model", () => {
  const out = repairLastRecipe({ backend: "claude-code", providerID: "litellm", modelID: "high", modelGroup: "high" }, "claude-opus-5");
  assert.equal(out.modelID, "claude-opus-5");
  assert.equal(out.modelGroup, null);
  // claude-code personas have no provider at all; one here leaked across from
  // the api-backend group-resolution path.
  assert.equal(out.providerID, null);
});

test("an api lastRecipe on a class is left alone — that is how the router is addressed", () => {
  const recipe = { backend: "api", providerID: "litellm", modelID: "med", modelGroup: "med" };
  assert.equal(repairLastRecipe(recipe, "claude-opus-5"), recipe);
});

test("a healthy claude-code lastRecipe is untouched", () => {
  const recipe = { backend: "claude-code", providerID: null, modelID: "claude-opus-5", modelGroup: null };
  assert.equal(repairLastRecipe(recipe, "claude-opus-5"), recipe);
});

test("a null lastRecipe (fresh install) is a no-op", () => {
  assert.equal(repairLastRecipe(null, "claude-opus-5"), null);
});
