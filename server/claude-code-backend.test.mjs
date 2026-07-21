import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeSession } from "./claude-code-backend.mjs";

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
