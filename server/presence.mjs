// "Which persona is Brian actually looking at right now" - fed by the
// client's visibilitychange/focus/blur/persona-switch listeners (POST
// /api/presence in index.mjs) plus a periodic heartbeat while visible+
// focused. Not persisted - a server restart resetting to "nothing watched"
// is the safe default (fires a push rather than wrongly staying silent).
//
// Extracted into its own module (rather than inline state in index.mjs, the
// project's one untested monolith) so the gating logic that decides whether
// a turn-finished push fires is unit-testable in isolation.

const DEFAULT_TTL_MS = 60_000;

/**
 * @param {number} ttlMs Presence older than this is treated as absent - a
 *   backstop against a client that goes away without cleanly signaling it
 *   (a crash/force-quit skips the pagehide handler that normally clears
 *   this immediately).
 */
export function createPresenceTracker(ttlMs = DEFAULT_TTL_MS) {
  let state = { personaId: null, updatedAt: 0 };
  return {
    /** Records the currently-watched persona (or null for "watching nothing"). */
    update(personaId) {
      state = { personaId: personaId ?? null, updatedAt: Date.now() };
    },
    /**
     * True if `personaId` is the one most recently reported as watched,
     * within ttlMs. Always false for null/undefined - "is nothing being
     * watched" isn't a meaningful question for a caller to ask (every real
     * call site passes an actual persona id), so this guards against ever
     * treating "watching nothing" internally as "yes, this [absent] thing
     * is being watched" for a caller that mistakenly passes one through.
     */
    isWatching(personaId) {
      if (personaId == null) return false;
      return state.personaId === personaId && Date.now() - state.updatedAt < ttlMs;
    },
  };
}
