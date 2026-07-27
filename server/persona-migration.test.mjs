import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migratePersonaToRouter,
  migratePersonas,
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
