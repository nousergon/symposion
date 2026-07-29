import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRetryGuard, requestFingerprint, DEDUP_MAX_ATTEMPTS } from "./retry-guard.mjs";

// symposion-I59. A persona resent an identical 98KB request every 30s for
// hours; every one was forwarded upstream and billed.
//
// The guard has to separate two things that look identical if you only hash
// the text: a request resent because nothing came back (the bug), and a user
// deliberately sending the same words again after a turn completed (normal).

const req = (over = {}) => ({
  providerID: "litellm",
  modelID: "high",
  system: "You are Vega.",
  text: "continue",
  attachments: [],
  ...over,
});

/** Guard driven by a controllable clock so window tests need no sleeping. */
function guardAt(t0 = 0, opts = {}) {
  const state = { now: t0 };
  const guard = makeRetryGuard({ clock: () => state.now, ...opts });
  return { guard, advance: (ms) => (state.now += ms) };
}

// ── fingerprint ──────────────────────────────────────────────────────────

test("identical requests fingerprint identically", () => {
  assert.equal(requestFingerprint(req()), requestFingerprint(req()));
});

test("a different model is a different request", () => {
  assert.notEqual(requestFingerprint(req()), requestFingerprint(req({ modelID: "low" })));
});

test("a different system prompt is a different request", () => {
  // The repo-context block is part of the system prompt, so cd'ing a persona
  // to another repo must not look like a resend of the same turn.
  assert.notEqual(requestFingerprint(req()), requestFingerprint(req({ system: "You are Rigel." })));
});

test("attachments contribute metadata and length, not bytes", () => {
  const a = req({ attachments: [{ mime: "image/png", filename: "a.png", base64: "AAAA" }] });
  const b = req({ attachments: [{ mime: "image/png", filename: "a.png", base64: "BBBB" }] });
  const c = req({ attachments: [{ mime: "image/png", filename: "a.png", base64: "AAAAAA" }] });
  assert.equal(requestFingerprint(a), requestFingerprint(b), "same length, same shape → same print");
  assert.notEqual(requestFingerprint(a), requestFingerprint(c), "different length → different print");
});

test("missing optional fields do not throw", () => {
  assert.equal(typeof requestFingerprint({}), "string");
});

// ── the loop it must catch ───────────────────────────────────────────────

test("blocks the attempt after the budget is spent", () => {
  const { guard } = guardAt();
  const h = requestFingerprint(req());
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS; i++) {
    assert.equal(guard.check(h).blocked, false, `attempt ${i + 1} should pass`);
  }
  const r = guard.check(h);
  assert.equal(r.blocked, true);
  assert.equal(r.attempts, DEDUP_MAX_ATTEMPTS + 1);
});

test("a blocked attempt is not recorded, so the lockout cannot self-extend", () => {
  // A caller that retries on rejection would otherwise push its own window
  // forward forever and never recover.
  const { guard } = guardAt();
  const h = requestFingerprint(req());
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS; i++) guard.check(h);
  const before = guard.size();
  guard.check(h);
  guard.check(h);
  assert.equal(guard.size(), before);
});

test("reports how long the loop has been running", () => {
  const { guard, advance } = guardAt();
  const h = requestFingerprint(req());
  guard.check(h);
  advance(30_000);
  guard.check(h);
  advance(30_000);
  guard.check(h);
  advance(30_000);
  assert.equal(guard.check(h).elapsedMs, 90_000);
});

// ── the false positive it must NOT cause ─────────────────────────────────

test("repeating the same message after each turn completes is never blocked", () => {
  // THE regression this module exists for. "continue" is the most-repeated
  // message a human sends an agent; counting identical text rather than
  // identical UNANSWERED requests blocks the 4th one mid-conversation.
  const { guard, advance } = guardAt();
  const h = requestFingerprint(req({ text: "continue" }));
  for (let i = 0; i < 10; i++) {
    assert.equal(guard.check(h).blocked, false, `send ${i + 1} should pass`);
    guard.settle(h); // the turn completed
    advance(5_000);
  }
});

test("settle releases exactly one slot, not the whole history", () => {
  // A genuine loop that happens to complete once must not win back its full
  // budget.
  const { guard } = guardAt();
  const h = requestFingerprint(req());
  guard.check(h);
  guard.check(h);
  guard.check(h);
  guard.settle(h);
  assert.equal(guard.check(h).blocked, false, "one slot was freed");
  assert.equal(guard.check(h).blocked, true, "and only one");
});

test("settling an unknown hash is a no-op", () => {
  const { guard } = guardAt();
  guard.settle("never-seen");
  assert.equal(guard.size(), 0);
});

test("different personas' requests do not interfere", () => {
  const { guard } = guardAt();
  const a = requestFingerprint(req({ system: "You are Vega." }));
  const b = requestFingerprint(req({ system: "You are Rigel." }));
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS; i++) guard.check(a);
  assert.equal(guard.check(a).blocked, true);
  assert.equal(guard.check(b).blocked, false);
});

// ── window expiry ────────────────────────────────────────────────────────

test("an abandoned attempt releases its slot once the window passes", () => {
  // A turn that died without settling must not consume budget forever.
  const { guard, advance } = guardAt(0, { windowMs: 1000 });
  const h = requestFingerprint(req());
  for (let i = 0; i < DEDUP_MAX_ATTEMPTS; i++) guard.check(h);
  assert.equal(guard.check(h).blocked, true);
  advance(1001);
  assert.equal(guard.check(h).blocked, false);
  assert.equal(guard.size(), 1);
});

test("a slow steady loop still trips the guard inside the window", () => {
  // 30s apart, the observed cadence — must block well before the window ends.
  const { guard, advance } = guardAt(0, { windowMs: 10 * 60 * 1000 });
  const h = requestFingerprint(req());
  let blockedAt = null;
  for (let i = 1; i <= 10 && blockedAt === null; i++) {
    if (guard.check(h).blocked) blockedAt = i;
    advance(30_000);
  }
  assert.equal(blockedAt, DEDUP_MAX_ATTEMPTS + 1);
});
