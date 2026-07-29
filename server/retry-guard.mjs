import { createHash } from "node:crypto";

/**
 * Retry-loop guard for the OpenCode transport (symposion-I59).
 *
 * A persona was observed resending an identical 98KB request every 30s for
 * hours, each one forwarded upstream by the egress proxy and billed. The
 * resend originates BELOW symposion's abstraction (SDK-internal retry), so it
 * is invisible as a symposion-level event and observable only as identical
 * request bodies at the proxy.
 *
 * Lives in its own module because `index.mjs` starts a server at import, so
 * anything needing a unit test has to be separable — the same reason
 * persona-migration.mjs and repo-context.mjs are separate (AGENTS.md).
 *
 * ── The semantic that matters ──
 *
 * An attempt counts against the budget only while it is UNSETTLED. A turn that
 * completes calls settle() and gives its slot back.
 *
 * Without that, the guard counts identical TEXT rather than identical
 * unanswered requests, and "continue" — the single most-repeated message a
 * human sends an agent — trips it on the 4th send even when all three previous
 * turns succeeded. The failure it must catch is "sent again because nothing
 * came back", which is exactly what an unsettled attempt is.
 */

export const DEDUP_WINDOW_MS = 10 * 60 * 1000;
export const DEDUP_MAX_ATTEMPTS = 3;

/**
 * Fingerprint everything that determines the upstream request. Attachments
 * contribute metadata + length rather than bytes: hashing megabytes of base64
 * on every turn to detect a resend would cost more than the resend.
 */
export function requestFingerprint({ providerID, modelID, system, text, attachments }) {
  const body = JSON.stringify({
    model: { providerID: providerID ?? null, modelID: modelID ?? null },
    system: system ?? "",
    text: text ?? "",
    attachments: (attachments ?? []).map((a) => ({
      mime: a.mime ?? null,
      filename: a.filename ?? null,
      len: a.base64?.length ?? 0,
    })),
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * @param {object}  [opts]
 * @param {number}  [opts.windowMs]      how long an unsettled attempt occupies a slot
 * @param {number}  [opts.maxAttempts]   unsettled attempts tolerated before blocking
 * @param {Function}[opts.clock]         injectable time source, for tests
 */
export function makeRetryGuard({
  windowMs = DEDUP_WINDOW_MS,
  maxAttempts = DEDUP_MAX_ATTEMPTS,
  clock = Date.now,
} = {}) {
  /** @type {{hash: string, ts: number}[]} */
  let inflight = [];

  const prune = (now) => {
    // An attempt older than the window is abandoned, not in flight: the turn
    // died without settling. Releasing the slot keeps a crashed turn from
    // permanently consuming budget.
    inflight = inflight.filter((r) => now - r.ts < windowMs);
  };

  return {
    /**
     * Record an attempt. Returns `{blocked: false}` to proceed, or
     * `{blocked: true, attempts, elapsedMs}` when the budget is exhausted.
     * A blocked attempt is NOT recorded — otherwise a caller that retries on
     * the rejection would extend its own lockout indefinitely.
     */
    check(hash) {
      const now = clock();
      prune(now);
      const dupes = inflight.filter((r) => r.hash === hash);
      if (dupes.length >= maxAttempts) {
        return { blocked: true, attempts: dupes.length + 1, elapsedMs: now - dupes[0].ts };
      }
      inflight.push({ hash, ts: now });
      return { blocked: false, attempts: dupes.length + 1 };
    },

    /**
     * A turn finished. Releases ONE slot for that hash — the oldest, since it
     * is the attempt that has been outstanding longest. Releasing all of them
     * would let a genuine loop reset its budget by completing once.
     */
    settle(hash) {
      const i = inflight.findIndex((r) => r.hash === hash);
      if (i !== -1) inflight.splice(i, 1);
    },

    /** Unsettled attempts currently held. Test/diagnostic surface. */
    size() {
      prune(clock());
      return inflight.length;
    },
  };
}
