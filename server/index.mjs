import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ClaudeCodeSession, CLAUDE_MODELS } from "./claude-code-backend.mjs";
import { OpenCodeServerPool } from "./opencode-pool.mjs";
import { loadPersonas, savePersonas, toRecord } from "./store.mjs";

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
    persona.claudeSession = new ClaudeCodeSession(persona.id, persona.modelID, persona.name, persona.workspaceDir, resuming);
  } else {
    if (persona.opencodeEntry) return;
    const entry = pool.getOrCreate(persona.workspaceDir);
    await entry.ready;
    persona.opencodeEntry = entry;
  }
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
      const claudeSession = new ClaudeCodeSession(id, modelID, name, workspaceDir);
      persona = {
        id, name, backend, modelID, workspaceDir,
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

    if (persona.backend === "api") {
      const result = await persona.opencodeEntry.client.session.prompt({
        path: { id: persona.sessionID },
        body: {
          model: { providerID: persona.providerID, modelID: persona.modelID },
          // Same identity fix as the claude-code backend: the model has no
          // idea it's "named" anything unless we actually tell it.
          system: `Your name is ${persona.name}. If asked your name or who you are, identify yourself as ${persona.name}.`,
          parts: [{ type: "text", text }],
        },
      });
      // Chat-only view: pull out ONLY text parts, drop reasoning/tool/step
      // parts by default - this is the "hide the code changes" behavior.
      replyText = (result.data?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    } else {
      const result = await persona.claudeSession.sendMessage(text);
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
