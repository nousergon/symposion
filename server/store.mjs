import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "personas.json");

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
    messages: p.messages,
    lastDenials: p.lastDenials ?? [],
  };
}
