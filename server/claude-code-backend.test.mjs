import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  ClaudeCodeSession,
  CLAUDE_MODELS,
  isValidClaudeModel,
  TURN_IDLE_TIMEOUT_MS,
  TURN_HARD_TIMEOUT_MS,
} from "./claude-code-backend.mjs";

// _handleLine is exercised directly against a minimal stand-in for `this`,
// bypassing the constructor's real `spawn(CLAUDE_BIN, ...)` - the method
// itself only touches queue/currentParts/blockTypes/onBackgroundEvent, none
// of which require a live child process. This keeps the regression test for
// symposion-I45 (background/detached turn events being silently discarded)
// fast and independent of whether a `claude` binary is present in CI.
function fakeSession() {
  return {
    queue: [],
    currentParts: [],
    blockTypes: new Map(),
    onBackgroundEvent: null,
    scheduledWakeup: null,
    _handleLine: ClaudeCodeSession.prototype._handleLine,
    _updateScheduledWakeup: ClaudeCodeSession.prototype._updateScheduledWakeup,
  };
}

function assistantLine(blocks) {
  return JSON.stringify({ type: "assistant", message: { content: blocks } });
}

function userToolResultLine(toolUseId, content, isError = false) {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } });
}

function resultLine(extra = {}) {
  return JSON.stringify({ type: "result", result: "", permission_denials: [], is_error: false, stop_reason: "end_turn", ...extra });
}

test("background: assistant tool_use with empty queue fires onBackgroundEvent(running), not a pending resolver", () => {
  const s = fakeSession();
  const events = [];
  s.onBackgroundEvent = (e) => events.push(e);

  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "Explore" } }]));

  assert.equal(events.length, 1);
  assert.equal(events[0].status, "running");
  assert.equal(events[0].parts.length, 1);
  assert.equal(events[0].parts[0].toolUseId, "t1");
  assert.equal(s.queue.length, 0);
});

test("background: tool_result (user event) with empty queue updates the part and fires onBackgroundEvent(running)", () => {
  const s = fakeSession();
  const events = [];
  s.onBackgroundEvent = (e) => events.push(e);

  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "Agent", input: {} }]));
  s._handleLine(userToolResultLine("t1", "done launching"));

  assert.equal(events.length, 2);
  assert.equal(events[1].status, "running");
  assert.equal(events[1].parts[0].output, "done launching");
  assert.equal(events[1].parts[0].isError, false);
});

test("background: result event with empty queue fires onBackgroundEvent(done) and resets currentParts", () => {
  const s = fakeSession();
  const events = [];
  s.onBackgroundEvent = (e) => events.push(e);

  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "Agent", input: {} }]));
  s._handleLine(resultLine());

  assert.equal(events.length, 2);
  assert.equal(events[1].status, "done");
  assert.equal(s.currentParts.length, 0);
});

test("foreground: events with a pending queue entry resolve normally and never call onBackgroundEvent", () => {
  const s = fakeSession();
  const backgroundEvents = [];
  s.onBackgroundEvent = (e) => backgroundEvents.push(e);

  let resolved = null;
  let toolUpdates = [];
  s.queue.push({
    resolve: (r) => (resolved = r),
    reject: () => assert.fail("should not reject"),
    onToolUpdate: (u) => toolUpdates.push(u),
  });

  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }]));
  s._handleLine(userToolResultLine("t1", "file contents"));
  s._handleLine(resultLine({ result: "done" }));

  assert.equal(backgroundEvents.length, 0);
  assert.equal(toolUpdates.length, 2);
  assert.equal(toolUpdates[0].status, "running");
  assert.equal(toolUpdates[1].status, "done");
  assert.ok(resolved);
  assert.equal(resolved.replyText, "done");
  assert.equal(s.queue.length, 0);
});

test("scheduledWakeup: a live ScheduleWakeup call sets an ETA + reason, resolved at the turn's result event", () => {
  const s = fakeSession();
  s.queue.push({ resolve: () => {}, reject: () => {}, onToolUpdate: () => {} });

  const before = Date.now();
  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { delaySeconds: 90, reason: "watching CI" } }]));
  s._handleLine(resultLine());

  assert.ok(s.scheduledWakeup);
  assert.equal(s.scheduledWakeup.reason, "watching CI");
  assert.ok(s.scheduledWakeup.at >= before + 90_000);
});

test("scheduledWakeup: stop:true clears it instead of setting an ETA", () => {
  const s = fakeSession();
  s.queue.push({ resolve: () => {}, reject: () => {}, onToolUpdate: () => {} });

  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { stop: true } }]));
  s._handleLine(resultLine());

  assert.equal(s.scheduledWakeup, null);
});

test("scheduledWakeup: a prior wakeup is cleared once a turn completes without re-scheduling one", () => {
  const s = fakeSession();
  s.queue.push({ resolve: () => {}, reject: () => {}, onToolUpdate: () => {} });
  s._handleLine(assistantLine([{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { delaySeconds: 60 } }]));
  s._handleLine(resultLine());
  assert.ok(s.scheduledWakeup);

  s.queue.push({ resolve: () => {}, reject: () => {}, onToolUpdate: () => {} });
  s._handleLine(assistantLine([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }]));
  s._handleLine(userToolResultLine("t2", "file1"));
  s._handleLine(resultLine());

  assert.equal(s.scheduledWakeup, null);
});

// ── model validation (symposion-I96) ───────────────────────────────────
//
// The CLI does not reject an unknown --model at spawn: it answers the turn
// with a 404 (`model_not_found`) wearing an ordinary assistant message, which
// in the UI is indistinguishable from the model declining to help. So the
// check has to happen here, before the process exists.

test("isValidClaudeModel accepts every model the UI offers", () => {
  for (const m of CLAUDE_MODELS) {
    assert.equal(isValidClaudeModel(m.modelID), true, `${m.modelID} rejected`);
  }
});

test("isValidClaudeModel rejects capability classes — the router's vocabulary, not the CLI's", () => {
  for (const group of ["low", "med", "high", "ultra"]) {
    assert.equal(isValidClaudeModel(group), false, `${group} accepted`);
  }
});

test("isValidClaudeModel rejects empty/absent models", () => {
  for (const bad of ["", null, undefined]) {
    assert.equal(isValidClaudeModel(bad), false, `${JSON.stringify(bad)} accepted`);
  }
});

test("constructing a session on a capability class throws instead of spawning", () => {
  assert.throws(
    () => new ClaudeCodeSession("s1", "high", "Zibal", "/tmp"),
    /unusable claude-code model: "high"/,
  );
});

test("the throw names the valid models, so the error is actionable", () => {
  assert.throws(
    () => new ClaudeCodeSession("s1", "gpt-5", "Zibal", "/tmp"),
    /claude-opus-5/,
  );
});

// ---------------------------------------------------------------------------
// Turn guards and terminal paths, against a fake child process.
//
// These go through the real constructor (via its spawnFn seam) rather than a
// prototype stand-in, because the defects they cover were all in the WIRING
// the constructor does - which listener is attached to which stream - not in
// the methods a stand-in would exercise.
// ---------------------------------------------------------------------------

function fakeChild() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

function spawnedSession() {
  const proc = fakeChild();
  const session = new ClaudeCodeSession("sess-1", "claude-opus-5", "Tester", "/tmp", false, null, null, {
    spawnFn: () => proc,
  });
  return { session, proc };
}

/** Let readline drain whatever was just written to the fake stdout. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Settle-tracking wrapper - lets a test assert a promise is STILL pending. */
function track(promise) {
  const state = { settled: null };
  promise.then(
    (value) => (state.settled = { value }),
    (error) => (state.settled = { error }),
  );
  return state;
}

test("idle guard: a turn that keeps producing output survives far past the old wall-clock cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, proc } = spawnedSession();
  const turn = track(session.sendMessage("go"));

  // Three 12-minute stretches of work, each ending in a tool call: 36 minutes
  // of continuous, visibly-alive progress. The 10-minute wall-clock cap this
  // replaces killed exactly this shape of turn - a research turn mid-flight,
  // 31 tool calls in - and reported it to the user as "process killed".
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(12 * 60 * 1000);
    proc.stdout.write(assistantLine([{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }]) + "\n");
    await flush();
  }

  assert.equal(turn.settled, null, "a turn emitting events throughout was killed anyway");
  assert.equal(proc.killed, false, "the process was killed while it was still producing output");
  assert.equal(session.alive, true);

  proc.stdout.write(resultLine({ result: "done" }) + "\n");
  await flush();
  assert.equal(turn.settled?.value?.replyText, "done");
});

test("idle guard: genuine silence past the threshold kills the process and rejects the turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, proc } = spawnedSession();
  const turn = track(session.sendMessage("go"));

  t.mock.timers.tick(TURN_IDLE_TIMEOUT_MS - 1000);
  await flush();
  assert.equal(turn.settled, null, "fired before the idle threshold was actually reached");

  t.mock.timers.tick(2000);
  await flush();
  assert.match(turn.settled?.error?.message ?? "", /no output for 15 minutes/);
  assert.equal(proc.killed, true, "a hung process must be killed, not left to be resumed");
  assert.equal(session.alive, false);
});

test("idle clock starts at enqueue, so a process that never answers at all still trips the guard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session } = spawnedSession();
  const turn = track(session.sendMessage("go"));

  t.mock.timers.tick(TURN_IDLE_TIMEOUT_MS + 1000);
  await flush();
  assert.match(turn.settled?.error?.message ?? "", /no output/);
});

test("hard cap: a turn still emitting events is ended once it passes the runaway limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, proc } = spawnedSession();
  const turn = track(session.sendMessage("go"));

  // Chatter forever: never idle, so only the non-resetting hard cap can end it.
  for (let elapsed = 0; elapsed < TURN_HARD_TIMEOUT_MS + 60_000; elapsed += 5 * 60 * 1000) {
    t.mock.timers.tick(5 * 60 * 1000);
    proc.stdout.write(assistantLine([{ type: "text", text: "still here" }]) + "\n");
    await flush();
    if (turn.settled) break;
  }

  assert.match(turn.settled?.error?.message ?? "", /hard limit/);
  assert.equal(proc.killed, true);
});

test("hard cap sits above the idle threshold, so idle is always the guard that fires first", () => {
  assert.ok(TURN_HARD_TIMEOUT_MS > TURN_IDLE_TIMEOUT_MS);
});

test("stdin error is listened for, so an EPIPE cannot become an uncaught exception", async () => {
  const { session, proc } = spawnedSession();

  // The regression this protects: with no listener, Node treats a stream
  // 'error' as an uncaught exception and the WHOLE server dies, taking every
  // other persona's in-flight turn with it. Observed live as `Error: write
  // EPIPE` right after the CLI exited on an unresumable session id.
  assert.ok(proc.stdin.listenerCount("error") > 0, "no stdin error listener - an EPIPE would kill the process");

  const turn = track(session.sendMessage("go"));
  proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await flush();

  assert.match(turn.settled?.error?.message ?? "", /stdin closed/);
  assert.equal(session.alive, false, "a session whose stdin died must not read as alive");
});

test("a write to an already-closed stdin rejects the turn instead of throwing", async () => {
  const { session, proc } = spawnedSession();
  // `alive` is still true here on purpose: it is cleared by the 'exit'
  // handler, which fires asynchronously, so this is the real-world window
  // where the child is gone but the session does not know it yet.
  proc.stdin.destroy();
  assert.equal(session.alive, true);

  const turn = track(session.sendMessage("go"));
  await flush();
  assert.match(turn.settled?.error?.message ?? "", /stdin is closed/);
});

test("process exit drains every queued turn and leaves no timer behind", async () => {
  const { session, proc } = spawnedSession();
  const first = track(session.sendMessage("one"));
  const second = track(session.sendMessage("two"));

  proc.emit("exit", 143, null);
  await flush();

  assert.match(first.settled?.error?.message ?? "", /exited \(code=143/);
  assert.match(second.settled?.error?.message ?? "", /exited \(code=143/);
  assert.equal(session.queue.length, 0);
  assert.equal(session.idleMs, null, "the liveness clock must reset once nothing is in flight");
});

test("idleMs reports silence while a turn is in flight and null when nothing is", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, proc } = spawnedSession();
  assert.equal(session.idleMs, null, "no turn in flight must report null, never 0");

  const turn = track(session.sendMessage("go"));
  t.mock.timers.tick(90_000);
  assert.equal(session.idleMs, 90_000);

  proc.stdout.write(resultLine({ result: "ok" }) + "\n");
  await flush();
  assert.equal(turn.settled?.value?.replyText, "ok");
  assert.equal(session.idleMs, null);
});
