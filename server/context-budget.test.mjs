import { test } from "node:test";
import assert from "node:assert/strict";
import {
  occupancyFromUsage,
  personaOccupancy,
  resolveWindow,
  bandFor,
  assessContext,
  formatTokens,
  NOTICE_FRACTION,
  ADVISE_FRACTION,
  URGENT_FRACTION,
  DEFAULT_CONTEXT_WINDOW,
  EXPENSIVE_RESUME_TOKENS,
  BAND_NONE,
  BAND_NOTICE,
  BAND_ADVISE,
  BAND_URGENT,
} from "./context-budget.mjs";

const usage = (o = {}) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...o });

test("occupancy INCLUDES cache reads - a cached token still occupies the window", () => {
  // The defect this guards: reading inputTokens alone (which reports only the
  // uncached remainder) convinces you an agentic loop is a fraction of its
  // real size. Here the true footprint is 400K and inputTokens says 1K.
  const u = usage({ inputTokens: 1_000, cacheReadTokens: 390_000, cacheWriteTokens: 5_000, outputTokens: 4_000 });
  assert.equal(occupancyFromUsage(u), 400_000);
});

test("occupancy is null when nothing was reported, never 0", () => {
  assert.equal(occupancyFromUsage(null), null);
  assert.equal(occupancyFromUsage(undefined), null);
  assert.equal(occupancyFromUsage(usage()), null, "an all-zero usage record is unmeasured, not empty");
});

test("persona occupancy is the LAST reported turn, not a lifetime sum", () => {
  // The bug this prevents: using totalUsage (a running total) would report a
  // persona as catastrophically full after a dozen small turns.
  const persona = {
    messages: [
      { role: "assistant", usage: usage({ cacheReadTokens: 50_000 }) },
      { role: "assistant", usage: usage({ cacheReadTokens: 60_000 }) },
      { role: "assistant", usage: usage({ cacheReadTokens: 70_000 }) },
    ],
  };
  assert.equal(personaOccupancy(persona), 70_000);
});

test("persona occupancy scans back past turns that reported nothing", () => {
  const persona = {
    messages: [
      { role: "assistant", usage: usage({ cacheReadTokens: 120_000 }) },
      { role: "user" },
      { role: "assistant", usage: null },
    ],
  };
  assert.equal(personaOccupancy(persona), 120_000);
});

test("a persona that has never spoken reports null occupancy", () => {
  assert.equal(personaOccupancy({ messages: [] }), null);
  assert.equal(personaOccupancy({}), null);
});

test("the window starts conservative and is corrected UPWARD by observation", () => {
  // A model id cannot be trusted to imply a window: a session can report
  // claude-opus-5 while running the 1M variant. Occupancy is proof by
  // existence - 834K is definitively not a 200K window.
  assert.equal(resolveWindow("claude-opus-5", {}), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveWindow("claude-opus-5", { "claude-opus-5": 834_455 }), 1_000_000);
});

test("an observation BELOW the default does not shrink the window", () => {
  assert.equal(resolveWindow("claude-opus-5", { "claude-opus-5": 12_000 }), DEFAULT_CONTEXT_WINDOW);
});

test("observations are per model id and do not leak between models", () => {
  const learned = { "claude-opus-5": 834_455 };
  assert.equal(resolveWindow("claude-haiku-4-5", learned), DEFAULT_CONTEXT_WINDOW);
});

test("an explicit [1m] marker resolves without needing an observation first", () => {
  assert.equal(resolveWindow("claude-opus-5[1m]", {}), 1_000_000);
});

test("bands match the Claude Code session-hygiene thresholds exactly", () => {
  // Mirrored, not re-chosen: two surfaces disagreeing about when a session is
  // too full is worse than either threshold being slightly wrong.
  assert.equal(bandFor(0.10), BAND_NONE);
  assert.equal(bandFor(NOTICE_FRACTION), BAND_NOTICE);
  assert.equal(bandFor(0.60), BAND_NOTICE);
  assert.equal(bandFor(ADVISE_FRACTION), BAND_ADVISE);
  assert.equal(bandFor(0.80), BAND_ADVISE);
  assert.equal(bandFor(URGENT_FRACTION), BAND_URGENT);
  assert.equal(bandFor(0.95), BAND_URGENT);
});

test("an unmeasured persona produces no assessment and no advice", () => {
  const r = assessContext({ occupancy: null, window: 1_000_000, ttlRemainingMs: 60_000 });
  assert.equal(r.fraction, null);
  assert.equal(r.advice, null);
  assert.equal(r.band, BAND_NONE);
});

test("the notice band stays SILENT on its own", () => {
  // 60% full with a healthy cache is not worth interrupting for. An advisory
  // that fires too often is ignored, which makes it worse than nothing.
  const r = assessContext({ occupancy: 600_000, window: 1_000_000, ttlRemainingMs: 55 * 60_000 });
  assert.equal(r.band, BAND_NOTICE);
  assert.equal(r.advice, null);
});

test("the advise band speaks on occupancy alone", () => {
  const r = assessContext({ occupancy: 800_000, window: 1_000_000, ttlRemainingMs: 55 * 60_000 });
  assert.equal(r.band, BAND_ADVISE);
  assert.match(r.advice, /80% full/);
  assert.match(r.advice, /new agent/i);
});

test("the urgent band names auto-compaction and outranks the cache advisories", () => {
  const r = assessContext({ occupancy: 900_000, window: 1_000_000, ttlRemainingMs: 60_000 });
  assert.equal(r.band, BAND_URGENT);
  assert.match(r.advice, /auto-compaction/i);
});

test("a large context nearing cache expiry warns BEFORE the cliff", () => {
  // The case a Stop hook structurally cannot cover: it sees elapsed idle only
  // in arrears, after the cost is sunk. A standing surface with a live
  // countdown can act while acting is still cheap.
  const r = assessContext({ occupancy: 700_000, window: 1_000_000, ttlRemainingMs: 4 * 60_000 });
  assert.equal(r.band, BAND_NOTICE, "must fire from a band that is otherwise silent");
  assert.match(r.advice, /Cache expires in 4m/);
  assert.match(r.advice, /700K in context/);
  assert.match(r.advice, /~13x/);
});

test("a SMALL context nearing cache expiry says nothing - expiry alone is not news", () => {
  const r = assessContext({ occupancy: 20_000, window: 1_000_000, ttlRemainingMs: 2 * 60_000 });
  assert.equal(r.advice, null);
  assert.equal(r.resumeMultiplier, null);
});

test("the expensive-resume threshold is where the advisory turns on", () => {
  const under = assessContext({ occupancy: EXPENSIVE_RESUME_TOKENS - 1, window: 1_000_000, ttlRemainingMs: 60_000 });
  const at = assessContext({ occupancy: EXPENSIVE_RESUME_TOKENS, window: 1_000_000, ttlRemainingMs: 60_000 });
  assert.equal(under.advice, null);
  assert.match(at.advice, /Cache expires/);
});

test("past the cliff, the advice changes from 'hurry' to 'a fresh start costs the same'", () => {
  // Once expired, the re-write is owed regardless, so telling the user to
  // hurry would be advice they can no longer act on.
  const r = assessContext({ occupancy: 500_000, window: 1_000_000, ttlRemainingMs: 0 });
  assert.match(r.advice, /Cache expired/);
  assert.doesNotMatch(r.advice, /expires in/);
  assert.match(r.advice, /about the same now and less afterwards/);
});

test("a full window on the conservative default still bands correctly", () => {
  // A 200K-window model at 180K is 90% full - urgent - even though the same
  // token count on a 1M window would be silent. The band is a fraction, and
  // the window resolution is what makes it meaningful.
  const r = assessContext({ occupancy: 180_000, window: DEFAULT_CONTEXT_WINDOW, ttlRemainingMs: 55 * 60_000 });
  assert.equal(r.band, BAND_URGENT);
});

test("formatTokens renders at the precision each magnitude deserves", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1_500), "1.5K");
  assert.equal(formatTokens(9_000), "9K");
  assert.equal(formatTokens(834_455), "834K");
  assert.equal(formatTokens(null), "");
});
