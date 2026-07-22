import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "personas.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

// Simple whole-file JSON store. Single local user, low write frequency -
// no need for sqlite/debouncing/concurrency handling at this scale.
// Only persists our OWN roster metadata + message log; the actual model
// conversation continuity lives in claude-code's / OpenCode's own on-disk
// session storage (confirmed empirically to survive process restarts).

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
  fs.writeFileSync(DATA_FILE, JSON.stringify(personaRecords, null, 2));
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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
  fs.writeFileSync(path.join(dir, id), buffer);
  return { id, filename, mime, sizeBytes: buffer.length };
}

/**
 * Resolves an attachment id to its on-disk path for the serving route.
 * `id` must be exactly a bare randomUUID() (as minted by saveAttachment
 * above) - rejecting anything else means a crafted id can never contain a
 * path separator, so there's nothing to traverse out of ATTACHMENTS_DIR with.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function attachmentFilePath(personaId, id) {
  if (!UUID_RE.test(id)) return null;
  const filePath = path.join(ATTACHMENTS_DIR, personaId, id);
  return fs.existsSync(filePath) ? filePath : null;
}

/** Strip a live persona object down to the plain-data fields worth persisting. */
export function toRecord(p) {
  return {
    id: p.id,
    name: p.name,
    backend: p.backend,
    providerID: p.providerID ?? null,
    modelID: p.modelID,
    workspaceDir: p.workspaceDir,
    actualCwd: p.actualCwd ?? p.workspaceDir,
    isolated: p.isolated ?? false,
    worktreeBranch: p.worktreeBranch ?? null,
    sessionID: p.sessionID ?? p.id, // claude-code personas: sessionID === persona id
    permissionMode: p.permissionMode ?? null, // claude-code only; null = CLI's own default (currently "auto")
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
    lastDenials: p.lastDenials ?? [],
    totalCostUsd: p.totalCostUsd ?? 0,
    totalUsage: p.totalUsage ?? null,
  };
}
