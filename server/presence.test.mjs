import { test } from "node:test";
import assert from "node:assert/strict";
import { createPresenceTracker } from "./presence.mjs";

test("nothing watched initially", () => {
  const presence = createPresenceTracker();
  assert.equal(presence.isWatching("p1"), false);
  assert.equal(presence.isWatching(null), false);
});

test("isWatching is true for the persona just updated", () => {
  const presence = createPresenceTracker();
  presence.update("p1");
  assert.equal(presence.isWatching("p1"), true);
});

test("isWatching is false for any other persona", () => {
  const presence = createPresenceTracker();
  presence.update("p1");
  assert.equal(presence.isWatching("p2"), false);
});

test("update(null) means watching nothing", () => {
  const presence = createPresenceTracker();
  presence.update("p1");
  presence.update(null);
  assert.equal(presence.isWatching("p1"), false);
  assert.equal(presence.isWatching(null), false); // null is "absent", never itself "watched"
});

test("update() with no argument defaults to null (clears presence)", () => {
  const presence = createPresenceTracker();
  presence.update("p1");
  presence.update();
  assert.equal(presence.isWatching("p1"), false);
});

test("a later update replaces the earlier one, not just adds to it", () => {
  const presence = createPresenceTracker();
  presence.update("p1");
  presence.update("p2");
  assert.equal(presence.isWatching("p1"), false);
  assert.equal(presence.isWatching("p2"), true);
});

test("presence older than ttlMs is treated as absent", async () => {
  const presence = createPresenceTracker(30);
  presence.update("p1");
  assert.equal(presence.isWatching("p1"), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(presence.isWatching("p1"), false);
});

test("a fresh update after expiry is watched again", async () => {
  const presence = createPresenceTracker(30);
  presence.update("p1");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(presence.isWatching("p1"), false);
  presence.update("p1");
  assert.equal(presence.isWatching("p1"), true);
});

test("two independent trackers don't share state", () => {
  const a = createPresenceTracker();
  const b = createPresenceTracker();
  a.update("p1");
  assert.equal(a.isWatching("p1"), true);
  assert.equal(b.isWatching("p1"), false);
});
