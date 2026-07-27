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
 * Applies {@link migratePersonaToRouter} across a list.
 *
 * @returns {{records: object[], migrated: number}}
 */
export function migratePersonas(records, litellmProviderID = LITELLM_PROVIDER_ID) {
  let migrated = 0;
  const out = records.map((r) => {
    const next = migratePersonaToRouter(r, litellmProviderID);
    if (next !== r) migrated += 1;
    return next;
  });
  return { records: out, migrated };
}
