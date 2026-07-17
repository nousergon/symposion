import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "personas.json");
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
    messages: p.messages,
    lastDenials: p.lastDenials ?? [],
    totalCostUsd: p.totalCostUsd ?? 0,
    totalUsage: p.totalUsage ?? null,
  };
}
