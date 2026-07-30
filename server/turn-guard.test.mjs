import { test } from "node:test";
import assert from "node:assert/strict";
import { claimTurn, settleTurn, RetryLoopBlocked } from "./turn-guard.mjs";
import { DEDUP_MAX_ATTEMPTS } from "./retry-guard.mjs";

// The budget algorithm itself is covered by retry-guard.test.mjs. What is
// covered here is the WIRING - which is where symposion-I101 lived: the guard
// was correct and well tested, and simply was not reachable from one of the
// two backends.

function persona(overrides = {}) {
  return { id: "p1", name: "Tester", backend: "claude-code", modelID: "claude-opus-5", providerID: null, ...overrides };
}

/** Send the same request `n` times without settling any of them. */
function sendUnsettled(p, n, request = { text: "continue" }) {
  const errors = [];
  for (let i = 0; i < n; i++) {
    try {
      claimTurn(p, request);
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

test("claude-code: an unsettled resend loop is bounded", () => {
  const p = persona({ backend: "claude-code" });
  const errors = sendUnsettled(p, DEDUP_MAX_ATTEMPTS + 1);

  assert.equal(errors.length, 1, "the claude-code transport was not bounded at all");
  assert.ok(errors[0] instanceof RetryLoopBlocked);
  assert.match(errors[0].message, /retry loop blocked/);
});

test("api: an unsettled resend loop is bounded identically", () => {
  const p = persona({ backend: "api", providerID: "litellm", modelID: "high" });
  const errors = sendUnsettled(p, DEDUP_MAX_ATTEMPTS + 1);

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof RetryLoopBlocked);
});

test("both backends get the SAME budget - the bound is not per-transport", () => {
  const cc = persona({ backend: "claude-code" });
  const api = persona({ backend: "api", providerID: "litellm" });

  const ccBlockedAt = sendUnsettled(cc, 10).length;
  const apiBlockedAt = sendUnsettled(api, 10).length;
  assert.equal(ccBlockedAt, apiBlockedAt);
});

test("a turn that COMPLETES gives its slot back, so repeated 'continue' never trips", () => {
  const p = persona();
  // The single most-repeated message a human sends an agent. Ten completed
  // turns in a row must not look like a loop.
  for (let i = 0; i < 10; i++) {
    const hash = claimTurn(p, { text: "continue" });
    settleTurn(p, hash);
  }
  assert.doesNotThrow(() => claimTurn(p, { text: "continue" }));
});

test("settling only on success is what makes the guard work - settling on failure disarms it", () => {
  const p = persona();
  // Simulates the bug this ordering prevents: releasing the slot on the
  // failure path. The loop then never trips, however long it runs.
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS * 3; i++) {
    const hash = claimTurn(p, { text: "same" });
    settleTurn(p, hash); // WRONG placement, on purpose
  }
  assert.doesNotThrow(() => claimTurn(p, { text: "same" }));

  // Whereas not settling - the real failure path - trips it.
  const q = persona();
  assert.equal(sendUnsettled(q, DEDUP_MAX_ATTEMPTS + 1).length, 1);
});

test("different text is a different request and does not consume the same budget", () => {
  const p = persona();
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS * 2; i++) {
    assert.doesNotThrow(() => claimTurn(p, { text: `distinct message ${i}` }));
  }
});

test("the system prompt participates in the fingerprint for backends that have one", () => {
  const p = persona({ backend: "api", providerID: "litellm" });
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS * 2; i++) {
    assert.doesNotThrow(() => claimTurn(p, { text: "same text", system: `repo context ${i}` }));
  }
});

test("claude-code passes no system prompt, and that absence is stable across turns", () => {
  // Regression guard: if the claude-code path ever started synthesising a
  // per-turn system prompt that varied, every request would fingerprint
  // uniquely and the budget would silently stop binding it again.
  const p = persona({ backend: "claude-code" });
  const a = claimTurn(p, { text: "x" });
  settleTurn(p, a);
  const b = claimTurn(p, { text: "x" });
  assert.equal(a, b, "identical claude-code requests must fingerprint identically");
});

test("the blocked error carries the numbers needed to act on it", () => {
  const p = persona();
  const errors = sendUnsettled(p, DEDUP_MAX_ATTEMPTS + 1);
  const err = errors[0];
  assert.equal(typeof err.requestHash, "string");
  assert.ok(err.attempts > DEDUP_MAX_ATTEMPTS);
  assert.equal(typeof err.elapsedMs, "number");
});

test("a blocked attempt is not itself recorded, so the lockout cannot self-extend", () => {
  const p = persona();
  sendUnsettled(p, DEDUP_MAX_ATTEMPTS);
  // Hammer it while blocked, then release the original slots. If blocked
  // attempts were recorded, these would keep the persona locked out.
  const hashes = [];
  for (let i = 0; i < 20; i++) {
    try {
      hashes.push(claimTurn(p, { text: "continue" }));
    } catch { /* expected */ }
  }
  assert.equal(hashes.length, 0);
  assert.equal(p._retryGuard.size(), DEDUP_MAX_ATTEMPTS);
});

test("the guard is created lazily on the persona and is not part of its record shape", () => {
  const p = persona();
  assert.equal(p._retryGuard, undefined);
  claimTurn(p, { text: "x" });
  assert.ok(p._retryGuard, "guard should be attached on first use");
  // Underscore-prefixed and absent from store.mjs's toRecord() allowlist, so
  // a restart starts with a clean budget - correct, since a restart also ends
  // whatever loop was running.
  assert.ok(Object.keys(p).some((k) => k === "_retryGuard"));
});

test("settleTurn on a persona that never claimed is a no-op, not a crash", () => {
  assert.doesNotThrow(() => settleTurn(persona(), "deadbeef"));
});
