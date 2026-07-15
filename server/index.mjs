import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ClaudeCodeSession, CLAUDE_MODELS } from "./claude-code-backend.mjs";
import { OpenCodeServerPool } from "./opencode-pool.mjs";
import { loadPersonas, savePersonas, toRecord } from "./store.mjs";
import { isGitRepo, createIsolatedWorktree } from "./worktree.mjs";
import { SseHub } from "./sse-hub.mjs";

const hub = new SseHub();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.join(os.homedir(), "Development");

const pool = new OpenCodeServerPool();

// MVP TTL window: not the real per-provider cache-expiry number (that varies
// by backend/provider and isn't worth pinning down yet) - just a stand-in
// window so we can validate whether the color-tint countdown concept feels
// right in the UI. Resets on every message, like the real thing would.
const TTL_WINDOW_MS = 60 * 60 * 1000; // 60 min

// Brian's chosen defaults (2026-07-14): Sonnet 5 for claude-code-backed
// personas, DeepSeek Flash for API-backed (OpenCode) personas.
const CLAUDE_CODE_DEFAULT = { modelID: "claude-sonnet-5" };
const API_DEFAULT = { providerID: "opencode", modelID: "deepseek-v4-flash-free" };
const DEFAULT_WORKSPACE = path.join(DEV_ROOT, "symposion");

/**
 * Persona shape (union over both backends):
 * { id, name, backend: "api"|"claude-code", providerID?, modelID, workspaceDir,
 *   sessionID?, claudeSession?, opencodeEntry?, lastActivityTs, messages: [],
 *   lastDenials: [] }
 * claudeSession/opencodeEntry are null until ensureConnected() lazily
 * (re)connects them - true right after loading from disk on startup.
 */
const personas = new Map();

function persistAll() {
  savePersonas([...personas.values()].map(toRecord));
}

for (const record of loadPersonas()) {
  personas.set(record.id, {
    ...record,
    claudeSession: null,
    opencodeEntry: null,
  });
}
console.log(`[store] loaded ${personas.size} persona(s) from disk`);

/** Lazily (re)connect a persona's backend process/session after a restart. */
async function ensureConnected(persona) {
  if (persona.backend === "claude-code") {
    if (persona.claudeSession && persona.claudeSession.alive) return;
    const resuming = persona.messages.length > 0;
    // Reconnect to the SAME worktree/cwd used originally - never re-derive
    // or re-create one on reconnect, or every restart would leak a new
    // worktree+branch for the same persona.
    persona.claudeSession = new ClaudeCodeSession(persona.id, persona.modelID, persona.name, persona.actualCwd, resuming);
  } else {
    if (persona.opencodeEntry) return;
    const entry = pool.getOrCreate(persona.workspaceDir);
    await entry.ready;
    persona.opencodeEntry = entry;
  }
}

/**
 * Fires an OpenCode prompt without blocking on the full response, streaming
 * text-part deltas via onDelta as they arrive on the pool entry's shared
 * /event feed, and resolving with the full text once the session goes idle.
 */
function promptOpenCodeStreaming(persona, text, onDelta) {
  const { client, events } = persona.opencodeEntry;
  const partTypes = new Map(); // partID -> type ("text" | "reasoning" | ...)
  let accumulated = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OpenCode turn timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    function onEvent(evt) {
      const props = evt.properties;
      if (!props || props.sessionID !== persona.sessionID) return;

      if (evt.type === "message.part.updated" && props.part?.id) {
        partTypes.set(props.part.id, props.part.type);
      } else if (evt.type === "message.part.delta" && props.field === "text") {
        if (partTypes.get(props.partID) === "text") {
          accumulated += props.delta;
          onDelta?.(props.delta);
        }
      } else if (evt.type === "session.idle") {
        cleanup();
        resolve(accumulated);
      } else if (evt.type === "session.error") {
        cleanup();
        reject(new Error(props.error?.message || "OpenCode session error"));
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      events.off("event", onEvent);
    }

    events.on("event", onEvent);

    client.session
      .promptAsync({
        path: { id: persona.sessionID },
        body: {
          model: { providerID: persona.providerID, modelID: persona.modelID },
          system: `Your name is ${persona.name}. If asked your name or who you are, identify yourself as ${persona.name}.`,
          parts: [{ type: "text", text }],
        },
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

function ttlInfo(persona) {
  const elapsed = Date.now() - persona.lastActivityTs;
  const remainingMs = Math.max(0, TTL_WINDOW_MS - elapsed);
  const remainingMin = remainingMs / 60000;
  let status = "green";
  if (remainingMin <= 5) status = "red";
  else if (remainingMin <= 10) status = "yellow";
  return { remainingMs, status };
}

function personaSummary(p) {
  const { remainingMs, status } = ttlInfo(p);
  return {
    id: p.id,
    name: p.name,
    backend: p.backend,
    providerID: p.providerID ?? null,
    modelID: p.modelID,
    workspaceDir: p.workspaceDir,
    workspaceName: path.basename(p.workspaceDir),
    isolated: p.isolated ?? false,
    worktreeBranch: p.worktreeBranch ?? null,
    ttlRemainingMs: remainingMs,
    ttlStatus: status,
    alive: p.backend === "claude-code" ? (p.claudeSession ? p.claudeSession.alive : true) : true,
    blocked: (p.lastDenials?.length ?? 0) > 0,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/workspaces", (req, res) => {
  try {
    const entries = fs
      .readdirSync(DEV_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(DEV_ROOT, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(entries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/providers", async (req, res) => {
  try {
    const entry = pool.getOrCreate(DEFAULT_WORKSPACE);
    await entry.ready;
    const providers = await entry.client.config.providers();
    const simplified = providers.data.providers.map((p) => ({
      providerID: p.id,
      name: p.name,
      models: Object.entries(p.models).map(([modelID, m]) => ({ modelID, name: m.name })),
    }));
    res.json(simplified);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/claude-models", (req, res) => {
  res.json(CLAUDE_MODELS);
});

app.get("/api/defaults", (req, res) => {
  res.json({ apiDefault: API_DEFAULT, claudeCodeDefault: CLAUDE_CODE_DEFAULT, defaultWorkspace: DEFAULT_WORKSPACE });
});

app.get("/api/personas", (req, res) => {
  res.json([...personas.values()].map(personaSummary));
});

function resolveWorkspaceDir(raw) {
  if (!raw) return DEFAULT_WORKSPACE;
  // Accept ~/... same as a shell would, since people will type it that way.
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

app.post("/api/personas", async (req, res) => {
  try {
    const { name, backend, providerID, modelID } = req.body ?? {};
    const workspaceDir = resolveWorkspaceDir(req.body?.workspaceDir);
    if (!name) return res.status(400).json({ error: "name is required" });
    if (backend !== "api" && backend !== "claude-code") {
      return res.status(400).json({ error: 'backend must be "api" or "claude-code"' });
    }
    if (!modelID) return res.status(400).json({ error: "modelID is required" });
    if (!path.isAbsolute(workspaceDir)) {
      return res.status(400).json({ error: `workspaceDir must be an absolute path (or start with ~): ${req.body?.workspaceDir}` });
    }
    if (!fs.existsSync(workspaceDir)) {
      return res.status(400).json({ error: `workspaceDir does not exist: ${workspaceDir}` });
    }
    if (!fs.statSync(workspaceDir).isDirectory()) {
      return res.status(400).json({ error: `workspaceDir is not a directory: ${workspaceDir}` });
    }

    let persona;
    if (backend === "api") {
      if (!providerID) return res.status(400).json({ error: "providerID is required for backend=api" });
      const entry = pool.getOrCreate(workspaceDir);
      await entry.ready;
      const session = await entry.client.session.create({ body: { title: name } });
      const id = session.data.id;
      persona = {
        id, name, backend, providerID, modelID, workspaceDir,
        sessionID: id,
        opencodeEntry: entry,
        lastActivityTs: Date.now(),
        messages: [],
        lastDenials: [],
      };
    } else {
      const id = randomUUID();

      // Concurrent-session git safety (Brian's standing rule): a claude-code
      // persona operating in a git repo runs in a dedicated worktree, never
      // the shared checkout directly - it could collide with Brian's own
      // terminal sessions or other personas on the same repo otherwise.
      let actualCwd = workspaceDir;
      let isolated = false;
      let worktreeBranch = null;
      if (isGitRepo(workspaceDir)) {
        const wt = createIsolatedWorktree(workspaceDir, name, id);
        actualCwd = wt.worktreePath;
        isolated = true;
        worktreeBranch = wt.branch;
      }

      const claudeSession = new ClaudeCodeSession(id, modelID, name, actualCwd);
      persona = {
        id, name, backend, modelID, workspaceDir, actualCwd, isolated, worktreeBranch,
        claudeSession,
        lastActivityTs: Date.now(),
        messages: [],
        lastDenials: [],
      };
    }

    personas.set(persona.id, persona);
    persistAll();
    res.status(201).json(personaSummary(persona));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/personas/:id/stream", (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  hub.subscribe(persona.id, res);
});

app.get("/api/personas/:id/messages", (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  res.json(persona.messages);
});

app.post("/api/personas/:id/messages", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text is required" });

  persona.messages.push({ role: "user", text, ts: Date.now() });

  try {
    await ensureConnected(persona);

    let replyText;
    let denials = [];

    const onDelta = (chunk) => hub.publish(persona.id, { type: "delta", text: chunk });

    if (persona.backend === "api") {
      replyText = await promptOpenCodeStreaming(persona, text, onDelta);
    } else {
      const result = await persona.claudeSession.sendMessage(text, onDelta);
      replyText = result.replyText;
      denials = result.permissionDenials;
    }

    persona.lastActivityTs = Date.now();
    persona.lastDenials = denials;
    persona.messages.push({
      role: "assistant",
      text: replyText || "(no text response)",
      ts: Date.now(),
      blocked: denials.length > 0,
      denials,
    });
    persistAll();
    hub.publish(persona.id, { type: "done", text: replyText, denials });

    res.json({ persona: personaSummary(persona), reply: replyText, denials });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.SYMPOSION_PORT || 5173;
app.listen(PORT, () => {
  console.log(`symposion MVP listening on http://127.0.0.1:${PORT}`);
});
