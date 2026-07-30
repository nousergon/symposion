import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "personas.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");
export const ARCHIVES_DIR = path.join(DATA_DIR, "archives");

// Simple whole-file JSON store. Single local user, low write frequency -
// no need for sqlite/debouncing/concurrency handling at this scale.
// Only persists our OWN roster metadata + message log; the actual model
// conversation continuity lives in claude-code's / OpenCode's own on-disk
// session storage (confirmed empirically to survive process restarts).

/**
 * Write a file so a reader never observes it half-written.
 *
 * `fs.writeFileSync` opens with O_TRUNC: it empties the target first, then
 * refills it. Anything interrupting the gap - a kill, a laptop sleep, a full
 * disk, or launchd's KeepAlive restarting the service mid-write - leaves a
 * truncated file. Because personas.json holds EVERY persona in one file, a
 * partial write during a routine single-persona update destroys unrelated
 * personas' history, and loadPersonas() then swallows the parse error and
 * starts empty. That is total, silent loss (symposion-I90).
 *
 * Temp-then-rename removes the gap: rename(2) is atomic within a filesystem,
 * so a concurrent reader sees the complete old file or the complete new one,
 * never a partial. The temp file MUST therefore live in the target's own
 * directory - renaming across filesystems is a copy, which is not atomic.
 *
 * Deliberately no fsync. Without it a power loss can lose the LAST write, but
 * cannot corrupt the file - APFS journals the metadata, so the rename either
 * happened or did not. Paying an fsync on every persona write (one per turn)
 * to convert "lose the last turn" into "lose nothing" is not a trade worth
 * making for a single-user local console; the property that matters is that
 * the file is never garbage.
 *
 * On failure the temp file is removed and the error rethrown - the original
 * is left untouched. That is a strict improvement on the previous behaviour,
 * where a full disk truncated the real file.
 */
export function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  // pid + random: two writers must never pick the same temp name, or one
  // renames the other's half-written bytes over the target.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup, then rethrow. Swallowing here would leave the
    // caller believing a write succeeded - the exact silent-failure class the
    // fleet's fail-loud rule forbids.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp may not exist (the writeFileSync itself failed). Nothing to
      // report: the real error is the one being rethrown below.
    }
    throw err;
  }
}

export function loadPersonas() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    console.error("[store] failed to read personas.json, starting empty:", err);
    return [];
  }
}

export function savePersonas(personaRecords) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(DATA_FILE, JSON.stringify(personaRecords, null, 2));
}

/**
 * Small whole-file JSON store for singleton app settings (currently just
 * lastRecipe - the backend/provider/model/permissionMode of the most
 * recently created persona, used to prefill the New Agent modal instead of
 * always resetting to the hardcoded CLAUDE_CODE_DEFAULT/API_DEFAULT).
 * Deliberately separate from personas.json since its shape and write
 * frequency are unrelated to the persona roster.
 */
export function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (err) {
    console.error("[store] failed to read settings.json, starting empty:", err);
    return {};
  }
}

export function saveSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Web Push subscriptions live inside settings.json as
 * settings.pushSubscriptions - a flat array of the browser's
 * PushSubscription.toJSON() objects, one per (browser, device) that's
 * granted permission. Deduped by endpoint (re-subscribing the same
 * browser/device - e.g. after clearing site data - yields a new endpoint,
 * so this is a real dedup key, not just an idempotency guard).
 */
export function addPushSubscription(subscription) {
  const settings = loadSettings();
  const subs = settings.pushSubscriptions ?? [];
  if (!subs.some((s) => s.endpoint === subscription.endpoint)) {
    subs.push(subscription);
    saveSettings({ ...settings, pushSubscriptions: subs });
  }
}

export function getPushSubscriptions() {
  return loadSettings().pushSubscriptions ?? [];
}

/** Drops a subscription the push service reported as dead (404/410). */
export function removePushSubscription(endpoint) {
  const settings = loadSettings();
  const subs = (settings.pushSubscriptions ?? []).filter((s) => s.endpoint !== endpoint);
  saveSettings({ ...settings, pushSubscriptions: subs });
}

/**
 * Persists an uploaded file's bytes to disk under a fresh randomUUID() name -
 * deliberately NOT derived from the user-supplied filename, so nothing
 * client-controlled ever touches the filesystem path (the original filename
 * is kept only as metadata, for display/Content-Disposition). Returns the
 * metadata that gets embedded in the message's `attachments` array; the
 * personas.json store stays metadata-only (id/filename/mime/size), never the
 * base64 bytes themselves, so the whole-file JSON store doesn't balloon.
 */
export function saveAttachment(personaId, { filename, mime, base64 }) {
  const id = randomUUID();
  const dir = path.join(ATTACHMENTS_DIR, personaId);
  fs.mkdirSync(dir, { recursive: true });
  const buffer = Buffer.from(base64, "base64");
  writeFileAtomic(path.join(dir, id), buffer);
  return { id, filename, mime, sizeBytes: buffer.length };
}

/**
 * Resolves an attachment id to its on-disk path for the serving route.
 * `id` must be exactly a bare randomUUID() (as minted by saveAttachment
 * above) - rejecting anything else means a crafted id can never contain a
 * path separator, so there's nothing to traverse out of ATTACHMENTS_DIR with.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Join `segments` under `baseDir` and return the path ONLY if it genuinely
 * lands inside it - otherwise null.
 *
 * The UUID check above already makes traversal impossible, since an anchored
 * `^[0-9a-f-]{36}$` cannot contain a separator or a dot. This is the second
 * lock, and it is worth having for two independent reasons:
 *
 *  - It is structural rather than lexical. It stays correct if someone later
 *    relaxes the id format, adds a caller that forgets the regex, or passes a
 *    segment from a new source - none of which the regex would survive.
 *  - It is checkable. CodeQL flagged the regex-guarded joins below as
 *    uncontrolled path expressions because it cannot see a regex as a
 *    sanitizer, and "the analyzer is wrong" is not a fix: a suppressed alert
 *    and a real one look identical six months later.
 *
 * Applied to attachments as well as archives - same defect class, and fixing
 * only the instance CodeQL happened to flag would leave the class open.
 */
function resolveWithin(baseDir, ...segments) {
  if (segments.some((s) => typeof s !== "string" || !s)) return null;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...segments);
  // The separator suffix matters: without it, `/data/archives-evil` passes a
  // naive startsWith check against `/data/archives`.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export function attachmentFilePath(personaId, id) {
  if (!UUID_RE.test(id)) return null;
  const filePath = resolveWithin(ATTACHMENTS_DIR, personaId, id);
  return filePath && fs.existsSync(filePath) ? filePath : null;
}

/**
 * Archive a persona's transcript when its session is reset (symposion-I107).
 *
 * One file per archive, NOT a growing array inside the persona record. A reset
 * exists to shrink what gets re-sent every turn, and `personas.json` is a
 * single whole-file atomic write holding every persona — appending discarded
 * transcripts to it would grow the file without bound and make each routine
 * per-turn write larger, which is the condition symposion-policy.md §6 E4
 * names as the trigger for leaving this store entirely. Off to the side, the
 * archive costs the live path nothing.
 *
 * Returns the archive's metadata; the caller persists nothing but that.
 */
export function archiveTranscript(personaId, messages, meta = {}) {
  const id = randomUUID();
  const dir = resolveWithin(ARCHIVES_DIR, personaId);
  if (!dir) throw new Error(`refusing to archive outside the archives directory: ${personaId}`);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    id,
    personaId,
    archivedAt: Date.now(),
    messageCount: messages.length,
    ...meta,
    messages,
  };
  writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return { id, archivedAt: record.archivedAt, messageCount: record.messageCount, ...meta };
}

/** Read one archived transcript back, or null if the id is unknown/bogus. */
export function loadArchive(personaId, id) {
  if (!UUID_RE.test(id) || !UUID_RE.test(personaId)) return null;
  const filePath = resolveWithin(ARCHIVES_DIR, personaId, `${id}.json`);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // A corrupt archive is not worth crashing a read-only history view over,
    // and it cannot affect the live transcript. Absent is the honest answer.
    return null;
  }
}

/** Delete every archive for a persona - called when the persona itself goes. */
export function removeArchives(personaId) {
  if (!UUID_RE.test(personaId)) return;
  const dir = resolveWithin(ARCHIVES_DIR, personaId);
  // A recursive force-delete is the one call here where a path escaping its
  // base would be destructive rather than merely wrong, so it gets the
  // strictest treatment: no path, no call.
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Strip a live persona object down to the plain-data fields worth persisting. */
export function toRecord(p) {
  return {
    id: p.id,
    name: p.name,
    backend: p.backend,
    providerID: p.providerID ?? null,
    modelID: p.modelID,
    modelGroup: p.modelGroup ?? null,
    workspaceDir: p.workspaceDir,
    actualCwd: p.actualCwd ?? p.workspaceDir,
    isolated: p.isolated ?? false,
    worktreeBranch: p.worktreeBranch ?? null,
    sessionID: p.sessionID ?? p.id, // claude-code personas: sessionID === persona id
    permissionMode: p.permissionMode ?? null, // claude-code only; null = CLI's own default (currently "auto")
    effortLevel: p.effortLevel ?? null, // claude-code only; null = CLI's own default
    lastActivityTs: p.lastActivityTs,
    // Live Remote Control handoff state ({ url, pid, startedAt } or null) -
    // persisted so a symposion restart doesn't orphan a handed-off persona:
    // the detached claude process (and the phone session on it) survives our
    // restart, and reclaim needs startedAt to know which transcript turns to
    // import back.
    handoff: p.handoff ?? null,
    // Auto-generated 1-2 sentence "what's being discussed" summary, shown at
    // the top of the chat - see updateSummary() in index.mjs.
    summary: p.summary ?? null,
    messages: p.messages,
    // Metadata ONLY for each prior session reset (id/archivedAt/messageCount).
    // The transcripts themselves live in ARCHIVES_DIR - see archiveTranscript()
    // for why they must not come back into this file.
    sessionArchives: p.sessionArchives ?? [],
    // A one-shot continuity note from the session this persona was reset from,
    // consumed by the next turn and then cleared. Persisted so a restart
    // between the reset and the next message doesn't silently drop it.
    carryOverSummary: p.carryOverSummary ?? null,
    // Persisted so an unattended persona that tripped the retry guard is still
    // visibly failed after a restart. A restart clears the guard's BUDGET (by
    // design - it also ends whatever loop was running), but the fact that the
    // last outcome was a failure is not something a restart should erase.
    lastTransportFailure: p.lastTransportFailure ?? null,
    lastDenials: p.lastDenials ?? [],
    totalCostUsd: p.totalCostUsd ?? 0,
    totalUsage: p.totalUsage ?? null,
  };
}
