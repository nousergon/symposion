import { test } from "node:test";
import assert from "node:assert/strict";
import { randomStarName } from "./star-names.mjs";

test("returns a name not in the excluded list", () => {
  const excluded = ["Vega", "Rigel", "Antares"];
  for (let i = 0; i < 50; i++) {
    const name = randomStarName(excluded);
    assert.ok(!excluded.map((n) => n.toLowerCase()).includes(name.toLowerCase()));
  }
});

test("exclusion match is case-insensitive", () => {
  for (let i = 0; i < 20; i++) {
    const name = randomStarName(["vega"]);
    assert.notEqual(name.toLowerCase(), "vega");
  }
});

test("falls back to a numbered variant once the whole pool is excluded", () => {
  // Exhaust the pool by asking for every name at least once, then excluding
  // all of them - the function must not loop forever or return a bare
  // duplicate.
  const seen = new Set();
  for (let i = 0; i < 2000 && seen.size < 500; i++) {
    seen.add(randomStarName([...seen]).toLowerCase());
  }
  const name = randomStarName([...seen]);
  assert.match(name, / \d+$/, `expected a numbered fallback, got "${name}"`);
});

test("never returns an empty string", () => {
  assert.notEqual(randomStarName([]), "");
});
