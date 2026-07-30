/**
 * Context occupancy and cache-window economics for a persona.
 *
 * Symposion's personas are long-lived, and both of the things that make a turn
 * expensive on this fleet's dominant lane are properties of the persona rather
 * than of the message being sent:
 *
 *  1. **Occupancy.** The whole conversation is re-sent every turn, so billed
 *     input scales linearly with how full the context window is. Measured
 *     across 212,277 turns (prompt-caching-policy.md §5.4a): a turn at 900K
 *     costs ~10x the same turn at 50K. A trivial "yes, do that" at 900K costs
 *     what a substantial turn costs — the price is the context, not the work.
 *
 *  2. **The cache TTL cliff.** The Max lane runs a 1-hour TTL, not the
 *     5-minute default. Share of turns re-writing more than half the prefix
 *     stays at 1.1–7.4% out to a 60-minute idle gap and jumps to 67.9% past
 *     it. Resuming after expiry re-writes the whole prefix at the 1.25x write
 *     premium, so a 900K session picked up 90 minutes later costs ~1.1M
 *     token-equivalents on its first turn — roughly 19x a cold start, and the
 *     single most expensive pattern available on this lane.
 *
 * Symposion already had half of this: `TTL_WINDOW_MS` is 60 minutes and the
 * sidebar counts it down. What it could not say is whether a given persona's
 * expiry MATTERS, because it never measured what the cache holds. A 20K
 * persona expiring is nothing; a 700K persona expiring is the 19x case.
 *
 * ── Why this is a better position than the Claude Code hook it mirrors ──
 *
 * session-hygiene-policy.md §3 trigger 5 names "impending idle longer than the
 * cache TTL" as the most expensive pattern AND as the one nothing currently
 * warns about, because a Stop hook "sees elapsed idle only in arrears, after
 * the cost is already sunk". Symposion is a standing surface with a live
 * countdown, so it can warn BEFORE the cliff rather than after it. That is the
 * one place this implementation should not simply copy the hook's behaviour.
 *
 * Thresholds are mirrored from claude-code-config's `session_hygiene` package
 * rather than re-chosen, so the two surfaces cannot drift into disagreeing
 * about when a session is too full.
 */

// ── Occupancy bands ────────────────────────────────────────────────────────
// Mirrored from session_hygiene/config.py. Below NOTICE nothing is said.
// NOTICE..ADVISE is tracked but does not speak on its own — it needs a
// corroborating signal, because an advisory that fires too often is ignored,
// at which point it is worse than nothing because it also costs attention.
// At ADVISE, occupancy alone is sufficient. URGENT is derived, not chosen:
// auto-compaction was measured firing from ~92.6% of the window, and 0.85
// leaves enough warning to act on.
export const NOTICE_FRACTION = 0.55;
export const ADVISE_FRACTION = 0.75;
export const URGENT_FRACTION = 0.85;

export const BAND_NONE = null;
export const BAND_NOTICE = "notice";
export const BAND_ADVISE = "advise";
export const BAND_URGENT = "urgent";

// Conservative default, corrected upward by observation (see resolveWindow).
// Starting conservative means the worst case is one premature advisory on a
// new model id, after which the learned value is cached and it cannot recur.
// Starting optimistic would mean silence forever on small-window models —
// the more expensive error for an advisory system.
export const DEFAULT_CONTEXT_WINDOW = 200_000;

// Above this many tokens, letting the cache expire is worth acting on: the
// post-expiry turn re-writes the whole prefix at the 1.25x write premium
// instead of re-reading it at ~0.1x, so ~100K tokens is where the difference
// stops being rounding and starts being real. Absolute rather than a fraction
// of the window on purpose — a 300K context is expensive to re-write whether
// that is 30% of a 1M window or 150% of a 200K one.
export const EXPENSIVE_RESUME_TOKENS = 100_000;

// What the prefix costs to re-read vs re-write, relative to uncached input.
// Used only to express the ratio in the advisory; not a billing calculation.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Tokens a turn's usage record says were in play.
 *
 * Cache reads are INCLUDED and are usually the bulk of it: a cached token
 * still occupies the window. Excluding them — the intuitive reading of
 * "input_tokens", which reports only the uncached remainder — convinces you an
 * agentic loop is a fraction of its real size (prompt-caching-policy.md §5.1).
 */
export function occupancyFromUsage(usage) {
  if (!usage) return null;
  const total =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return total > 0 ? total : null;
}

/**
 * Current occupancy for a persona: what its NEXT turn will carry.
 *
 * Read from the most recent turn that reported usage, scanning backwards -
 * not from `totalUsage`, which is a lifetime SUM across every turn and grows
 * without bound. Confusing the two would report a persona as catastrophically
 * full after a dozen small turns.
 */
export function personaOccupancy(persona) {
  const messages = persona?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const occupancy = occupancyFromUsage(messages[i]?.usage);
    if (occupancy !== null) return occupancy;
  }
  return null;
}

/**
 * The context window a persona is actually running with.
 *
 * The model id alone cannot be trusted to imply a window size: a session can
 * report `claude-opus-5` while running the 1M-context variant. So observation
 * wins over declaration — an occupancy of 834K is proof by existence that the
 * window is not 200K, and it is the only signal here that cannot lie.
 *
 * Resolution order: a learned floor for this model id, then a `[1m]` marker if
 * the id carries one, then the conservative default.
 *
 * @param {string} modelID
 * @param {Record<string, number>} [learned] - model id -> largest occupancy
 *   ever observed for it.
 */
export function resolveWindow(modelID, learned = {}) {
  const observed = learned?.[modelID];
  if (typeof observed === "number" && observed > DEFAULT_CONTEXT_WINDOW) {
    // Round the proof-by-existence up to the next plausible window rather than
    // treating the largest seen turn as the ceiling: a session observed at
    // 834K is running a 1M window, not an 834K one, and reporting 100% full
    // at 834K would be a false alarm at the worst possible moment.
    return observed > 200_000 ? 1_000_000 : DEFAULT_CONTEXT_WINDOW;
  }
  if (typeof modelID === "string" && modelID.includes("[1m]")) return 1_000_000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function bandFor(fraction) {
  if (fraction >= URGENT_FRACTION) return BAND_URGENT;
  if (fraction >= ADVISE_FRACTION) return BAND_ADVISE;
  if (fraction >= NOTICE_FRACTION) return BAND_NOTICE;
  return BAND_NONE;
}

/**
 * Everything the UI needs to say about a persona's context and cache state.
 *
 * @param {object} input
 * @param {number|null} input.occupancy      tokens currently in the window
 * @param {number} input.window              the model's context window
 * @param {number} input.ttlRemainingMs      time left on the 1-hour cache window
 * @returns {{
 *   occupancy: number|null, window: number, fraction: number|null,
 *   band: string|null, resumeMultiplier: number|null, advice: string|null
 * }}
 *   `advice` is null when there is nothing worth saying — which is the common
 *   case and deliberately so.
 */
export function assessContext({ occupancy, window, ttlRemainingMs }) {
  const result = {
    occupancy: occupancy ?? null,
    window,
    fraction: null,
    band: BAND_NONE,
    resumeMultiplier: null,
    advice: null,
  };
  if (occupancy === null || occupancy === undefined || !window) return result;

  result.fraction = occupancy / window;
  result.band = bandFor(result.fraction);

  // What the first turn after cache expiry costs relative to the same turn
  // taken while the cache is still warm.
  const expensiveToResume = occupancy >= EXPENSIVE_RESUME_TOKENS;
  if (expensiveToResume) {
    result.resumeMultiplier = Math.round(CACHE_WRITE_MULTIPLIER / CACHE_READ_MULTIPLIER);
  }

  const pct = Math.round(result.fraction * 100);
  const minutesLeft = Math.max(0, Math.round(ttlRemainingMs / 60000));
  const cacheExpiringSoon = ttlRemainingMs > 0 && minutesLeft <= 10;
  const cacheExpired = ttlRemainingMs <= 0;

  // Ordered by what it costs to ignore, most expensive first.
  if (result.band === BAND_URGENT) {
    result.advice = `Context ${pct}% full — auto-compaction is close. Start a new agent for the next piece of work.`;
  } else if (cacheExpired && expensiveToResume) {
    // Already past the cliff: the next turn pays the full re-write no matter
    // what, so the honest advice is not "hurry" — it is that continuing here
    // now costs about what a fresh start costs, and a fresh start is smaller
    // from then on.
    result.advice = `Cache expired with ${formatTokens(occupancy)} in context — the next turn re-writes the whole prefix (~${result.resumeMultiplier}x a warm turn). A new agent costs about the same now and less afterwards.`;
  } else if (cacheExpiringSoon && expensiveToResume) {
    // The prospective warning a Stop hook structurally cannot give: act
    // BEFORE the boundary, while acting is still cheap.
    result.advice = `Cache expires in ${minutesLeft}m with ${formatTokens(occupancy)} in context. Finish here now, or start a new agent — resuming after expiry costs ~${result.resumeMultiplier}x.`;
  } else if (result.band === BAND_ADVISE) {
    result.advice = `Context ${pct}% full — every turn now bills the whole context. Consider a new agent for unrelated work.`;
  }
  // BAND_NOTICE stays silent on its own, by design: it speaks only via the
  // cache-expiry branches above, which are its corroborating signal.

  return result;
}

/** 1234 -> "1.2K", 834455 -> "834K". */
export function formatTokens(n) {
  if (n === null || n === undefined) return "";
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(n / 1000)}K`;
}
