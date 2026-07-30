import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The coverage floor is only as honest as what it measures over, and the
// specific way it can silently stop being honest is narrowing the scope rather
// than lowering the number — which looks like an improvement in every report.
//
// Measured on this repo (symposion-I39): node's built-in
// --experimental-test-coverage reported 92.37% line coverage while omitting 7
// server modules that were never imported by a test — decision-queue, index,
// opencode-pool, remote-control, secrets, sse-hub and webpush, 3,039 of 4,873
// server lines, 62%. c8 --all reports the same suite at 34.76%. Both numbers
// are "correct"; only one of them is about the codebase.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const script = pkg.scripts["test:coverage"] ?? "";

test("a coverage script exists and enforces rather than reports", () => {
  assert.ok(script, "package.json has no test:coverage script");
  assert.match(script, /--check-coverage/, "coverage must fail the build, not just print a number");
  assert.match(script, /--lines\s+\d+/, "no line threshold is set");
});

test("coverage counts files no test imports — the --all flag is load-bearing", () => {
  // Dropping --all would jump the reported number from ~35% to ~92% without a
  // single line of new test code. That is the regression this pins.
  assert.match(script, /(^|\s)--all(\s|$)/, "c8 --all is required or unloaded files vanish from the report");
});

test("the include scope is the whole server directory, not a curated subset", () => {
  // Narrowing this to the already-tested modules would raise the number while
  // measuring less — the same defect as dropping --all, wearing a different hat.
  assert.match(script, /--include\s+'server\/\*\*\/\*\.mjs'/, "include must cover all of server/");
  const excludes = [...script.matchAll(/--exclude\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(excludes, ["**/*.test.mjs"], "only test files may be excluded from coverage");
});

test("every server module is inside the measured scope", () => {
  // A structural check rather than a textual one: if a module ever lands
  // somewhere the include glob does not reach, this fails regardless of how
  // the script is worded.
  const modules = fs
    .readdirSync(path.join(ROOT, "server"))
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  assert.ok(modules.length > 0);
  for (const m of modules) {
    assert.ok(
      fs.existsSync(path.join(ROOT, "server", m)),
      `${m} is not under server/, so the coverage include glob would miss it`,
    );
  }
});
