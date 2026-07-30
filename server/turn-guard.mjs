import { makeRetryGuard, requestFingerprint } from "./retry-guard.mjs";

/**
 * The retry-loop budget, as ONE chokepoint both backends pass through.
 *
 * `retry-guard.mjs` holds the budget algorithm and is well covered. What was
 * missing was the wiring: every call site lived inside
 * `promptOpenCodeStreaming()`, so the budget bound the `api` transport and the
 * `claude-code` transport had no bound at all (symposion-I101).
 *
 * That was the wrong half to have covered. `/loop` + `ScheduleWakeup` — a
 * persona that re-sends itself a prompt on a timer, with no human in the loop
 * to notice it is stuck — is `claude-code`-only (see
 * `ClaudeCodeSession._updateScheduledWakeup`). The transport that can generate
 * a self-sustaining resend loop was the unguarded one.
 *
 * This module exists rather than a second copy of the three call sites in the
 * `claude-code` arm, because a rule that exists twice drifts — and because
 * `index.mjs` starts a server at import, so a guard written there cannot be
 * tested at all. The wiring is where the defect was, so the wiring is what
 * needs the test.
 *
 * symposion-policy.md T0-3 (Tier 0): "No unbounded resend loop. A transport
 * that cannot make progress fails loudly and marks the persona failed."
 */

/**
 * Thrown by claimTurn() when a persona has re-sent the same request too many
 * times without any of them completing. A distinct type so the caller can
 * answer it as the client error it is (429) rather than a generic failure —
 * "you are in a loop" and "the upstream broke" need different reactions.
 */
export class RetryLoopBlocked extends Error {
  constructor(message, { requestHash, attempts, elapsedMs }) {
    super(message);
    this.name = "RetryLoopBlocked";
    this.requestHash = requestHash;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Claim a budget slot for a turn about to be dispatched.
 *
 * @param {object} persona - live persona; the guard is lazily created on it
 *   and deliberately NOT persisted (`toRecord()`'s allowlist drops it), so a
 *   restart starts with a clean budget. That is correct: a restart also ends
 *   whatever loop was running.
 * @param {{text?: string, attachments?: Array, system?: string|null}} request
 *   `system` is the per-turn system prompt where the backend has one. The
 *   `claude-code` backend passes null: its identity prompt is fixed at spawn
 *   via `--append-system-prompt`, so nothing in it varies per turn and
 *   including it would add a constant to every fingerprint.
 * @returns {string} the request hash - hand it to settleTurn() on SUCCESS.
 * @throws {RetryLoopBlocked}
 */
export function claimTurn(persona, { text, attachments, system = null }) {
  // Fingerprint everything that determines the upstream request, computed
  // synchronously before any async work so detection does not depend on the
  // event loop being responsive - which, during a retry storm, it is not.
  const requestHash = requestFingerprint({
    providerID: persona.providerID,
    modelID: persona.modelID,
    system,
    text,
    attachments,
  });

  persona._retryGuard ??= makeRetryGuard();
  const verdict = persona._retryGuard.check(requestHash);
  if (!verdict.blocked) return requestHash;

  const elapsedS = Math.round(verdict.elapsedMs / 1000);
  const kbSize = Math.round(JSON.stringify({ text, system: system ?? "" }).length / 1024);
  throw new RetryLoopBlocked(
    `Identical ${kbSize}KB request sent ${verdict.attempts} times in ${elapsedS}s without one completing — retry loop blocked. ` +
      `The persona is stuck resending the same prompt without a successful response. ` +
      `Check the upstream provider status and the persona's conversation history.`,
    { requestHash, attempts: verdict.attempts, elapsedMs: verdict.elapsedMs },
  );
}

/**
 * Release this turn's slot — and ONLY on success.
 *
 * A turn that errored or timed out keeps its slot, which is precisely what
 * lets a repeated-failure loop exhaust the budget while a human re-sending
 * "continue" after each completed turn never does. Calling this on the failure
 * path would disarm the guard completely.
 */
export function settleTurn(persona, requestHash) {
  persona._retryGuard?.settle(requestHash);
}
