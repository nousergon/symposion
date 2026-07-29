/**
 * Migrates persisted personas onto the LiteLLM router (2026-07-27 cutover).
 *
 * Symposion used to reach direct-API providers through one local egress
 * proxy per provider (deepseek=8972, xai=8973, gemini=8974), each with its
 * own OpenCode provider entry. The fleet consolidated onto a single
 * multi-tenant DLP proxy and a LiteLLM router; those three ports were
 * retired and every persona pinned to them broke.
 *
 * Personas persisted before the cutover still carry the retired providerID
 * and a concrete modelID. Left alone, each one's next message hangs or
 * errors against a dead port. This rewrites them onto the router at load
 * time.
 *
 * Deliberately coarse: the old concrete model maps to a capability CLASS,
 * not to another concrete model. An exact restoration is neither possible
 * (several of those models are deprecated or gone) nor desirable — the
 * point of the cutover is that the registry decides what a class means, not
 * a persona record written months ago.
 */

import { isValidClaudeModel } from "./claude-code-backend.mjs";

/** Providers whose per-provider egress-proxy ports no longer exist. */
export const RETIRED_PROVIDER_IDS = new Set(["deepseek", "xai", "gemini"]);

/**
 * Substrings marking a model as a reasoning/strategic tier. The old bridge
 * encoded the same coarse split: `deepseek-reasoner` was the strategic
 * model, `deepseek-chat` the cheap per-item one.
 */
export const REASONING_MODEL_HINTS = ["reasoner", "-pro", "thinking", "opus"];

export const LITELLM_PROVIDER_ID = "litellm";

/**
 * @param {object} record persisted persona record
 * @param {string} litellmProviderID
 * @returns {object} the same object when no migration applies, otherwise a
 *   new record pointed at the router. Identity is meaningful: callers use
 *   `result !== record` to count migrations.
 */
export function migratePersonaToRouter(record, litellmProviderID = LITELLM_PROVIDER_ID) {
  // claude-code personas never had a providerID — they are a different
  // backend entirely and are unaffected by the cutover.
  if (record.backend !== "api") return record;
  if (!RETIRED_PROVIDER_IDS.has(record.providerID)) return record;

  const modelID = REASONING_MODEL_HINTS.some((h) => (record.modelID ?? "").includes(h))
    ? "high"
    : "med";

  return {
    ...record,
    providerID: litellmProviderID,
    modelID,
    // Record the class so the UI shows this persona as class-addressed
    // rather than pinned to a model that no longer means anything.
    modelGroup: modelID,
  };
}

/**
 * Repairs a claude-code persona persisted with a model the CLI cannot use.
 *
 * Distinct from the router migration above, and for a different reason. The
 * New Agent modal hid its "Model tier" dropdown for the claude-code backend
 * but never cleared its VALUE, and the create handler read that value
 * regardless of backend - so a claude-code persona could be created with
 * `modelGroup: "high"`, which the server resolved to `modelID: "high"` and
 * handed to `claude -p --model high`. Every turn came back as a 404
 * (`model_not_found`) rendered as an ordinary assistant reply, and because
 * the class name was also written into `lastRecipe`, every claude-code agent
 * created afterwards inherited it (symposion-I96).
 *
 * Those records outlive the code fix, so they are repaired at load time
 * rather than left to throw on spawn: an unusable model is rewritten onto the
 * concrete default with the class dropped, since a class has no meaning in
 * this backend and nothing recoverable is encoded in it.
 *
 * @param {object} record persisted persona record
 * @param {string} defaultModelID concrete fallback (CLAUDE_CODE_DEFAULT)
 * @returns {object} the same object when no repair applies, otherwise a new
 *   record on a usable model. Identity is meaningful - see migratePersonas().
 */
export function repairClaudeCodeModel(record, defaultModelID) {
  if (record.backend !== "claude-code") return record;
  if (isValidClaudeModel(record.modelID) && !record.modelGroup) return record;
  return { ...record, modelID: isValidClaudeModel(record.modelID) ? record.modelID : defaultModelID, modelGroup: null };
}

/**
 * Same repair for the persisted `lastRecipe`, which prefills the New Agent
 * modal. Left alone it re-mints the defect on the next agent created - the
 * record repair above would then have to catch it again, one boot too late.
 *
 * @returns {object|null} the same object when no repair applies
 */
export function repairLastRecipe(recipe, defaultModelID) {
  if (!recipe || recipe.backend !== "claude-code") return recipe;
  if (isValidClaudeModel(recipe.modelID) && !recipe.modelGroup && !recipe.providerID) return recipe;
  return {
    ...recipe,
    // claude-code personas have no providerID at all; one present here came
    // from the api-backend group-resolution path leaking across.
    providerID: null,
    modelID: isValidClaudeModel(recipe.modelID) ? recipe.modelID : defaultModelID,
    modelGroup: null,
  };
}

/**
 * Applies {@link migratePersonaToRouter} and {@link repairClaudeCodeModel}
 * across a list.
 *
 * @returns {{records: object[], migrated: number}}
 */
export function migratePersonas(records, litellmProviderID = LITELLM_PROVIDER_ID, claudeCodeDefaultModelID = "claude-opus-5") {
  let migrated = 0;
  const out = records.map((r) => {
    const next = repairClaudeCodeModel(migratePersonaToRouter(r, litellmProviderID), claudeCodeDefaultModelID);
    if (next !== r) migrated += 1;
    return next;
  });
  return { records: out, migrated };
}
