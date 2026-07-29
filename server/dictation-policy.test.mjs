import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

// symposion-I91. Dictation died on the first natural pause: the Web Speech API
// ends its own session on a silence gap even with continuous = true, and
// `onend` tore everything down instead of restarting. `onerror` separately
// discarded the error object, so a blocked microphone and a normal stop looked
// identical to the user and in the console.
//
// The restart decision is the fix, and it is the part that can go badly wrong
// in both directions — too permissive is a hot loop against a dead mic, too
// strict is the original bug. So it lives in its own DOM-free script and is
// tested here.
//
// public/app.js is a classic script and cannot be imported; loading the policy
// with node:vm tests the exact file the browser runs, with no duplicate copy to
// drift. (Making app.js itself testable is symposion-I39 / policy T1-1.)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(__dirname, "..", "public", "dictation-policy.js");

function loadPolicy() {
  const sandbox = { globalThis: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(POLICY, "utf8"), sandbox);
  return sandbox.DictationPolicy;
}

const P = loadPolicy();
const decide = (over = {}) => P.decideDictationNext({ wanted: true, emptyRestarts: 0, ...over });

test("the browser script actually exposes the policy", () => {
  // If app.js's `window.DictationPolicy.decideDictationNext(...)` call ever
  // stops resolving, dictation throws on the first session end.
  assert.equal(typeof P.decideDictationNext, "function");
});

// ── the original bug: dying on a natural pause ───────────────────────────

test("a silence gap restarts instead of ending dictation", () => {
  // THE regression. `no-speech` is what the engine reports for a pause, and
  // treating it as the end of dictation is the whole defect.
  const v = decide({ error: "no-speech" });
  assert.equal(v.action, "restart");
  assert.equal(v.message, null, "a pause is not something to tell the user about");
});

test("a session that simply ends restarts while the user is still dictating", () => {
  assert.equal(decide({ error: null }).action, "restart");
});

test("restarting survives many consecutive pauses as long as speech keeps arriving", () => {
  // emptyRestarts resets to 0 whenever a session produced final text, so a
  // long dictation with real pauses never approaches the cap.
  for (let i = 0; i < 25; i++) {
    assert.equal(decide({ error: "no-speech", emptyRestarts: 0 }).action, "restart");
  }
});

// ── the opposite failure: a hot restart loop ─────────────────────────────

test("stops once too many restarts produce no speech", () => {
  const v = decide({ error: "no-speech", emptyRestarts: P.DEFAULT_MAX_EMPTY_RESTARTS });
  assert.equal(v.action, "stop");
  assert.equal(v.reason, "no-speech");
  assert.match(v.message, /no speech detected/i);
});

test("the empty-restart cap is configurable and enforced at the boundary", () => {
  assert.equal(decide({ error: "no-speech", emptyRestarts: 1, maxEmptyRestarts: 2 }).action, "restart");
  assert.equal(decide({ error: "no-speech", emptyRestarts: 2, maxEmptyRestarts: 2 }).action, "stop");
});

// ── errors the user must be told about ───────────────────────────────────

for (const code of ["not-allowed", "service-not-allowed", "audio-capture"]) {
  test(`${code} stops and explains, rather than failing silently`, () => {
    const v = decide({ error: code });
    assert.equal(v.action, "stop");
    assert.equal(v.reason, "terminal-error");
    assert.ok(v.message && v.message.length > 20, "must carry an actionable message");
  });
}

test("a terminal error is reported even if the user had already stopped", () => {
  // Otherwise the next attempt fails the same silent way.
  const v = decide({ wanted: false, error: "not-allowed" });
  assert.equal(v.action, "stop");
  assert.ok(v.message);
});

test("an unrecognised error code stops and names the code", () => {
  // Restarting into an unknown failure is how a hot loop starts; guessing it
  // is benign is the same mistake in a different place.
  const v = decide({ error: "some-future-code" });
  assert.equal(v.action, "stop");
  assert.equal(v.reason, "unknown-error");
  assert.match(v.message, /some-future-code/);
});

// ── user-initiated stop ──────────────────────────────────────────────────

test("a user stop ends dictation quietly", () => {
  const v = decide({ wanted: false });
  assert.equal(v.action, "stop");
  assert.equal(v.message, null, "the user knows they pressed stop");
});

test("a user stop wins over a pending benign error", () => {
  assert.equal(decide({ wanted: false, error: "no-speech" }).action, "stop");
});

test("aborted ends dictation quietly — it is our own stop() coming back", () => {
  const v = decide({ error: "aborted" });
  assert.equal(v.action, "stop");
  assert.equal(v.message, null);
});

// ── shape ────────────────────────────────────────────────────────────────

test("every verdict is actionable", () => {
  const cases = [
    {}, { error: "no-speech" }, { error: "aborted" }, { error: "not-allowed" },
    { error: "network" }, { wanted: false }, { error: "no-speech", emptyRestarts: 99 },
  ];
  for (const c of cases) {
    const v = decide(c);
    assert.ok(["restart", "stop"].includes(v.action), `bad action for ${JSON.stringify(c)}`);
    assert.equal(typeof v.reason, "string");
    assert.ok(v.message === null || typeof v.message === "string");
    assert.ok(!(v.action === "restart" && v.message), "a restart must not nag the user");
  }
});

test("missing state does not throw", () => {
  assert.equal(typeof P.decideDictationNext({}).action, "string");
  assert.equal(typeof P.decideDictationNext().action, "string");
});
