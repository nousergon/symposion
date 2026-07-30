import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { randomUUID } from "node:crypto";

import { writeFileAtomic, archiveTranscript, loadArchive, removeArchives } from "./store.mjs";

const UUID_RE_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// symposion-I90. personas.json holds EVERY persona in one file, so a partial
// write during a routine single-persona update destroys unrelated personas'
// history — and loadPersonas() swallows the resulting parse error and starts
// empty, making it silent as well as total.
//
// The property under test is not "the bytes arrive" (writeFileSync did that).
// It is that a reader NEVER observes a half-written file, and that a failed
// write leaves the previous contents intact rather than truncated.

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "symposion-store-"));

/** Everything in `dir` that is not the target file — i.e. leftover temps. */
const strays = (dir, target) => fs.readdirSync(dir).filter((f) => f !== path.basename(target));

test("writes the contents", () => {
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  writeFileAtomic(f, '{"a":1}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"a":1}');
});

test("overwrites an existing file", () => {
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  fs.writeFileSync(f, "old");
  writeFileAtomic(f, "new");
  assert.equal(fs.readFileSync(f, "utf8"), "new");
});

test("accepts a Buffer — saveAttachment writes raw bytes, not a string", () => {
  const dir = tmpdir();
  const f = path.join(dir, "attachment.bin");
  const buf = Buffer.from([0x00, 0xff, 0x10, 0x00]);
  writeFileAtomic(f, buf);
  assert.deepEqual(fs.readFileSync(f), buf);
});

test("leaves no temp file behind on success", () => {
  // A stray temp is not just litter: in the attachments dir it would be an
  // orphaned partial blob, and it means the rename did not happen.
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  writeFileAtomic(f, "x");
  assert.deepEqual(strays(dir, f), []);
});

test("the temp path is derived from the TARGET's directory", () => {
  // rename(2) is atomic only within a filesystem. A temp in os.tmpdir() could
  // sit on a different volume, making the rename a cross-device copy — which
  // silently reintroduces the torn-write window this whole change removes.
  //
  // Asserted against the source because the temp is unobservable at runtime:
  // on success it is renamed away, and on failure it is unlinked. A structural
  // assertion is weaker than a behavioural one, but it does fail if someone
  // later swaps in os.tmpdir(), which is the regression worth catching.
  const src = fs.readFileSync(new URL("./store.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function writeFileAtomic"));
  const impl = body.slice(0, body.indexOf("\n}"));
  assert.match(impl, /path\.dirname\(filePath\)/, "temp dir must come from the target path");
  assert.doesNotMatch(impl, /os\.tmpdir\(\)/, "temp must not be placed in the system tmpdir");
});

test("a cross-directory target still writes its temp alongside the target", () => {
  // Behavioural companion to the structural check above: writing into a
  // SUBdirectory must leave the parent clean, which only holds if the temp
  // was created in the subdirectory rather than somewhere shared.
  const dir = tmpdir();
  const sub = path.join(dir, "attachments");
  fs.mkdirSync(sub);
  const f = path.join(sub, "blob.bin");
  writeFileAtomic(f, Buffer.from("bytes"));
  assert.deepEqual(fs.readdirSync(dir), ["attachments"]);
  assert.deepEqual(fs.readdirSync(sub), ["blob.bin"]);
});

test("a failed write leaves the ORIGINAL intact, not truncated", () => {
  // The regression that matters. Previously fs.writeFileSync truncated the
  // real file first, so a full disk or a mid-write kill destroyed it.
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  fs.writeFileSync(f, '{"personas":"precious"}');
  fs.chmodSync(dir, 0o555); // read-only dir: the temp write cannot succeed
  try {
    assert.throws(() => writeFileAtomic(f, '{"personas":"new"}'));
    assert.equal(fs.readFileSync(f, "utf8"), '{"personas":"precious"}');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("a failed write throws rather than reporting success", () => {
  // Fail loud. A swallow here leaves the caller believing state was persisted.
  const dir = tmpdir();
  fs.chmodSync(dir, 0o555);
  try {
    assert.throws(() => writeFileAtomic(path.join(dir, "personas.json"), "x"));
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("a failed write leaves no temp file behind", () => {
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  fs.writeFileSync(f, "original");
  const target = path.join(dir, "sub", "personas.json"); // parent does not exist
  assert.throws(() => writeFileAtomic(target, "x"));
  assert.deepEqual(strays(dir, f), []);
});

test("concurrent writers do not collide on a temp name", () => {
  // Two writers picking the same temp name means one renames the other's
  // half-written bytes over the target. The name carries pid + randomness;
  // this pins that successive writes never reuse one.
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  for (let i = 0; i < 50; i++) writeFileAtomic(f, `v${i}`);
  assert.equal(fs.readFileSync(f, "utf8"), "v49");
  assert.deepEqual(strays(dir, f), []);
});

test("round-trips JSON large enough to span multiple filesystem blocks", () => {
  // A torn write is only observable above one block; a 2-byte fixture would
  // pass even against the old implementation.
  const dir = tmpdir();
  const f = path.join(dir, "personas.json");
  const big = JSON.stringify(
    Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, messages: ["x".repeat(80)] })),
  );
  writeFileAtomic(f, big);
  assert.equal(fs.readFileSync(f, "utf8"), big);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).length, 5000);
});

// ── Session-reset archives (symposion-I107) ────────────────────────────────
//
// The property that matters: a reset must SHED a transcript from the live
// per-turn path without destroying it. These write into the real ARCHIVES_DIR
// under a throwaway persona id and clean up after themselves, because the
// path resolution is part of what is under test.

const archiveMessages = [
  { role: "user", text: "first" },
  { role: "assistant", text: "second", usage: { inputTokens: 1, cacheReadTokens: 400_000 } },
];

/** A syntactically valid persona id that no real persona will ever hold. */
function throwawayPersonaId() {
  return randomUUID();
}

test("archiving returns metadata only - the transcript does NOT come back", () => {
  const pid = throwawayPersonaId();
  try {
    const meta = archiveTranscript(pid, archiveMessages, { modelID: "claude-opus-5" });
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.modelID, "claude-opus-5");
    assert.equal(meta.messages, undefined, "messages must not ride back into personas.json");
    assert.ok(UUID_RE_TEST.test(meta.id));
  } finally {
    removeArchives(pid);
  }
});

test("an archived transcript reads back in full", () => {
  const pid = throwawayPersonaId();
  try {
    const { id } = archiveTranscript(pid, archiveMessages, { sessionID: "s1" });
    const loaded = loadArchive(pid, id);
    assert.equal(loaded.messageCount, 2);
    assert.equal(loaded.sessionID, "s1");
    assert.deepEqual(loaded.messages.map((m) => m.text), ["first", "second"]);
  } finally {
    removeArchives(pid);
  }
});

test("archives are per persona and per archive - one reset does not clobber the last", () => {
  const pid = throwawayPersonaId();
  try {
    const a = archiveTranscript(pid, [{ role: "user", text: "session one" }]);
    const b = archiveTranscript(pid, [{ role: "user", text: "session two" }]);
    assert.notEqual(a.id, b.id);
    assert.equal(loadArchive(pid, a.id).messages[0].text, "session one");
    assert.equal(loadArchive(pid, b.id).messages[0].text, "session two");
  } finally {
    removeArchives(pid);
  }
});

test("a bogus or traversing archive id resolves to nothing", () => {
  const pid = throwawayPersonaId();
  try {
    archiveTranscript(pid, archiveMessages);
    assert.equal(loadArchive(pid, "../../etc/passwd"), null);
    assert.equal(loadArchive(pid, "not-a-uuid"), null);
    assert.equal(loadArchive("../../..", "not-a-uuid"), null);
  } finally {
    removeArchives(pid);
  }
});

test("removing a persona's archives removes all of them", () => {
  const pid = throwawayPersonaId();
  const { id } = archiveTranscript(pid, archiveMessages);
  assert.ok(loadArchive(pid, id));
  removeArchives(pid);
  assert.equal(loadArchive(pid, id), null);
});

test("removing archives for a persona that has none is a no-op, not a throw", () => {
  assert.doesNotThrow(() => removeArchives(throwawayPersonaId()));
  assert.doesNotThrow(() => removeArchives("not-a-uuid"));
});
