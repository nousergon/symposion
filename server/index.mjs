import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ClaudeCodeSession, CLAUDE_MODELS, CLAUDE_PERMISSION_MODES } from "./claude-code-backend.mjs";
import { OpenCodeServerPool } from "./opencode-pool.mjs";
import { loadPersonas, savePersonas, toRecord, saveAttachment, attachmentFilePath, ATTACHMENTS_DIR } from "./store.mjs";
import { isGitRepo, createIsolatedWorktree, removeWorktreeAndBranch } from "./worktree.mjs";
import { SseHub } from "./sse-hub.mjs";
import { resolveSecret } from "./secrets.mjs";
import { ensureDeepseekProxy } from "./deepseek-proxy.mjs";

const hub = new SseHub();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.join(os.homedir(), "Development");

// Resolved once at startup (env override, else SSM /symposion/DEEPSEEK_API_KEY)
// and handed ONLY to the local content-scanning egress proxy (deepseek-
// proxy.mjs), never to symposion's own process.env or an `opencode serve`
// child's env - OpenCode's "deepseek" provider config points at that local
// proxy with a placeholder key instead, so the real key never reaches an
// unscanned outbound request (symposion#6; see deepseek-proxy.mjs and
// ~/Development/.llm-routing/deepseek_egress_proxy.py for why this proxy
// exists at all). Missing key, or the proxy failing to come up, just means
// the real-account deepseek provider silently doesn't work - not
// startup-fatal, since the free opencode-zen proxy still works either way.
const deepseekKey = await resolveSecret("DEEPSEEK_API_KEY");
if (deepseekKey) await ensureDeepseekProxy(deepseekKey);
else console.warn("[secrets] DEEPSEEK_API_KEY not found (env or SSM) - real DeepSeek account provider will not be available");

const pool = new OpenCodeServerPool();

// TTL window: confirmed empirically correct for claude-code personas -
// subscription auth gets the real 1-hour ephemeral cache (verified via
// usage.cache_creation.ephemeral_1h_input_tokens in spike output). For
// api-backend (OpenCode) personas the real per-provider cache-expiry window
// is NOT knowable through OpenCode's abstraction - this is a stand-in best
// guess, surfaced to the UI as approximate (ttlApproximate below) rather
// than shown with the same confidence as the confirmed claude-code number.
// Resets on every message, like the real thing would. See symposion#5.
const TTL_WINDOW_MS = 60 * 60 * 1000; // 60 min

// Brian's chosen defaults (2026-07-14): Sonnet 5 for claude-code-backed
// personas, DeepSeek for API-backed (OpenCode) personas - the real DeepSeek
// account (provider "deepseek"), not OpenCode Zen's free proxy (provider
// "opencode"), now that a real key is wired up (symposion#6).
const CLAUDE_CODE_DEFAULT = { modelID: "claude-sonnet-5" };
const API_DEFAULT = { providerID: "deepseek", modelID: "deepseek-chat" };
// ~/Development itself, not a specific repo under it - most new personas
// aren't working on symposion, and the old default silently pointed every
// unconfigured persona at symposion's own working tree.
const DEFAULT_WORKSPACE = DEV_ROOT;

/**
 * Persona shape (union over both backends):
 * { id, name, backend: "api"|"claude-code", providerID?, modelID, workspaceDir,
 *   sessionID?, claudeSession?, opencodeEntry?, lastActivityTs, messages: [],
 *   lastDenials: [], pendingPermission?, pendingQuestion? }
 * claudeSession/opencodeEntry are null until ensureConnected() lazily
 * (re)connects them - true right after loading from disk on startup.
 * pendingPermission/pendingQuestion (api backend only) are transient live
 * state - never persisted, always reconciled fresh from the OpenCode server
 * on connect (see connectApiPersona). pendingTurn (both backends) is the
 * same kind of transient live state - the text accumulated so far for a
 * turn that's still generating, so a client that (re)connects mid-turn
 * (persona switch, page reload, tab revisit) can pick up exactly where the
 * turn currently stands instead of seeing nothing until it completes, or
 * losing whatever streamed while it wasn't subscribed. See GET .../messages.
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
    pendingPermission: null,
    pendingQuestion: null,
    pendingTurn: null,
  });
}
console.log(`[store] loaded ${personas.size} persona(s) from disk`);

function normalizePermission(p) {
  return { id: p.id, action: p.permission, resources: p.patterns ?? [], metadata: p.metadata };
}
function normalizeQuestion(q) {
  return { id: q.id, questions: q.questions, tool: q.tool };
}

/**
 * Wires an api-backend persona to a pool entry: subscribes to that entry's
 * shared event feed for permission/question requests scoped to this
 * persona's session, and reconciles any request that was ALREADY pending
 * before this listener attached (e.g. the server restarted mid-request) via
 * GET /permission and /question - otherwise a persona could be left
 * permanently blocked with no way for the UI to ever learn about it.
 *
 * Everything here deliberately stays on the v1-generation REST surface
 * (postSessionIdPermissionsPermissionId, /permission, /question/*) - verified
 * empirically that the newer /api/session/{id}/permission|question endpoints
 * are a SEPARATE registry that never sees requests created via this v1
 * client's session.promptAsync (replies 404 PermissionNotFoundError even
 * called within milliseconds of the request being asked). See opencode-pool.mjs.
 */
async function connectApiPersona(persona, entry) {
  await entry.ready;
  persona.opencodeEntry = entry;

  const { events } = entry;
  events.on("event", (evt) => {
    const props = evt.properties;
    if (!props || props.sessionID !== persona.sessionID) return;

    if (evt.type === "permission.asked") {
      persona.pendingPermission = normalizePermission(props);
      hub.publish(persona.id, { type: "blocked", kind: "permission", request: persona.pendingPermission });
    } else if (evt.type === "permission.replied") {
      persona.pendingPermission = null;
      hub.publish(persona.id, { type: "unblocked", kind: "permission" });
    } else if (evt.type === "question.asked") {
      persona.pendingQuestion = normalizeQuestion(props);
      hub.publish(persona.id, { type: "blocked", kind: "question", request: persona.pendingQuestion });
    } else if (evt.type === "question.replied" || evt.type === "question.rejected") {
      persona.pendingQuestion = null;
      hub.publish(persona.id, { type: "unblocked", kind: "question" });
    }
  });

  const [permissions, questions] = await Promise.all([
    pool.listPermissions(entry.port),
    pool.listQuestions(entry.port),
  ]);
  const perm = permissions.find((p) => p.sessionID === persona.sessionID);
  if (perm) persona.pendingPermission = normalizePermission(perm);
  const ques = questions.find((q) => q.sessionID === persona.sessionID);
  if (ques) persona.pendingQuestion = normalizeQuestion(ques);
}

/** Lazily (re)connect a persona's backend process/session after a restart. */
async function ensureConnected(persona) {
  if (persona.backend === "claude-code") {
    if (persona.claudeSession && persona.claudeSession.alive) return;
    const resuming = persona.messages.length > 0;
    // Reconnect to the SAME worktree/cwd used originally - never re-derive
    // or re-create one on reconnect, or every restart would leak a new
    // worktree+branch for the same persona.
    persona.claudeSession = new ClaudeCodeSession(persona.id, persona.modelID, persona.name, persona.actualCwd, resuming, persona.permissionMode);
  } else {
    // Runs on every call, not just first-connect: the deepseek egress
    // proxy is a separate process from the opencode pool entry below, so it
    // can die independently AFTER a persona is already connected (verified
    // live, symposion#24 - a manually-killed proxy left every subsequent
    // message to a "deepseek"-provider persona hanging forever with no
    // error surfaced, since ensureDeepseekProxy() previously only ran once
    // at server startup). ensureDeepseekProxy() itself is a cheap
    // health-check-first, spawn-if-not-running call - negligible cost when
    // the proxy's already healthy, the common case.
    if (persona.providerID === "deepseek" && deepseekKey) {
      await ensureDeepseekProxy(deepseekKey);
    }
    if (persona.opencodeEntry) return;
    // Reconnect to the SAME worktree/cwd used originally, same as claude-code
    // above - actualCwd falls back to workspaceDir for personas predating
    // isolation support.
    const entry = pool.getOrCreate(persona.actualCwd ?? persona.workspaceDir);
    await connectApiPersona(persona, entry);
  }
}

/**
 * Fires an OpenCode prompt without blocking on the full response, streaming
 * text-part deltas via onDelta as they arrive on the pool entry's shared
 * /event feed, and resolving with the full text (+ ordered tool-call parts,
 * for the visibility toggle - symposion#4) once the session goes idle.
 */
function promptOpenCodeStreaming(persona, text, attachments, onDelta, onToolUpdate) {
  const { client, events } = persona.opencodeEntry;
  const partTypes = new Map(); // partID -> type ("text" | "reasoning" | ...)
  let accumulated = "";

  // Ordered text/tool parts for the whole turn, keyed by OpenCode's own
  // stable part.id (confirmed empirically to stay constant across a tool
  // call's pending->running->completed lifecycle) so text and tool entries
  // interleave in true chronological order, not grouped by kind.
  const orderedParts = [];
  const partIndexById = new Map();

  // message.updated fires multiple times per turn as the assistant message
  // streams (confirmed live) - just keep the latest snapshot, which is
  // already the final/complete cost+tokens by the time session.idle fires.
  let usage = null;

  return new Promise((resolve, reject) => {
    let timeout = setTimeout(onTimeout, 5 * 60 * 1000);

    function onTimeout() {
      cleanup();
      reject(new Error("OpenCode turn timed out after 5 minutes"));
    }

    function onEvent(evt) {
      const props = evt.properties;
      if (!props || props.sessionID !== persona.sessionID) return;

      if (evt.type === "message.part.updated" && props.part?.id) {
        const { id, type } = props.part;
        partTypes.set(id, type);
        if (type === "text" && !partIndexById.has(id)) {
          partIndexById.set(id, orderedParts.length);
          orderedParts.push({ type: "text", text: "" });
        } else if (type === "tool") {
          const state = props.part.state?.status ?? "pending";
          const toolPart = {
            type: "tool",
            toolUseId: id,
            name: props.part.tool,
            input: props.part.state?.input ?? {},
            output: props.part.state?.output ?? null,
            isError: state === "error",
          };
          if (partIndexById.has(id)) {
            orderedParts[partIndexById.get(id)] = toolPart;
          } else {
            partIndexById.set(id, orderedParts.length);
            orderedParts.push(toolPart);
          }
          // "pending"/"running" both read as "still going" to callers - OpenCode's
          // own pending->running transition happens too fast to be worth a
          // separate UI state, unlike its distinct completed/error outcomes.
          onToolUpdate?.({ ...toolPart, status: state === "completed" ? "done" : state === "error" ? "error" : "running" });
        } else if (type === "subtask" && !partIndexById.has(id)) {
          // Subagent dispatch - OpenCode models this as its own part type
          // (SubtaskPartInput: prompt/description/agent), not a "tool" part,
          // and unlike a "tool" part it carries no state/status field at all
          // - there's no completion event to key off, only the parent turn
          // eventually going idle. Reshaped into the same {type:"tool",
          // name:"Agent"} shape the claude-code backend uses so it gets
          // identical live-list/collapsed-toggle rendering (including the
          // Agent-specific styling and elapsed timer in app.js) for free.
          // Without this branch these parts were silently dropped - a
          // subagent dispatch on the OpenCode backend had zero visibility,
          // not even a flat row.
          const toolPart = {
            type: "tool",
            toolUseId: id,
            name: "Agent",
            input: { subagent_type: props.part.agent, description: props.part.description, prompt: props.part.prompt },
            output: null,
            isError: false,
          };
          partIndexById.set(id, orderedParts.length);
          orderedParts.push(toolPart);
          onToolUpdate?.({ ...toolPart, status: "running" });
        }
        // "reasoning"/"step-start"/"step-finish" intentionally skipped - chat-only view.
      } else if (evt.type === "message.part.delta" && props.field === "text") {
        if (partTypes.get(props.partID) === "text") {
          accumulated += props.delta;
          const idx = partIndexById.get(props.partID);
          if (idx !== undefined) orderedParts[idx].text += props.delta;
          onDelta?.(props.delta);
        }
      } else if (evt.type === "message.updated" && props.info?.role === "assistant") {
        const { cost, tokens } = props.info;
        usage = {
          costUsd: cost ?? 0,
          usage: tokens
            ? {
                inputTokens: tokens.input ?? 0,
                outputTokens: tokens.output ?? 0,
                cacheReadTokens: tokens.cache?.read ?? 0,
                cacheWriteTokens: tokens.cache?.write ?? 0,
              }
            : null,
        };
      } else if (evt.type === "session.idle") {
        cleanup();
        resolve({ text: accumulated, parts: orderedParts, ...(usage ?? { costUsd: 0, usage: null }) });
      } else if (evt.type === "session.error") {
        cleanup();
        reject(new Error(props.error?.message || "OpenCode session error"));
      } else if (evt.type === "permission.asked" || evt.type === "question.asked") {
        // The turn is now waiting on a human, not stuck - restart the guard
        // timer from here so a permission/question prompt left open for a
        // few minutes doesn't spuriously time out the whole turn.
        clearTimeout(timeout);
        timeout = setTimeout(onTimeout, 5 * 60 * 1000);
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
          // FilePartInput.url accepts a data: URI for inline (non-workspace)
          // content - the standard mechanism for handing OpenCode a file that
          // doesn't already exist on disk in the session's workspace.
          parts: [
            ...(text ? [{ type: "text", text }] : []),
            ...(attachments ?? []).map((a) => ({ type: "file", mime: a.mime, filename: a.filename, url: `data:${a.mime};base64,${a.base64}` })),
          ],
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

/**
 * Adds one turn's cost/token usage to a persona's running totals. costUsd is
 * the pay-as-you-go-equivalent dollar value even for subscription-billed
 * claude-code personas (confirmed live in the claude CLI's own result
 * event) - a genuinely useful cost signal regardless of billing model.
 */
function accumulateUsage(persona, costUsd, usage) {
  persona.totalCostUsd = (persona.totalCostUsd ?? 0) + (costUsd ?? 0);
  if (!usage) return;
  const t = persona.totalUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  t.inputTokens += usage.inputTokens ?? 0;
  t.outputTokens += usage.outputTokens ?? 0;
  t.cacheReadTokens += usage.cacheReadTokens ?? 0;
  t.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  persona.totalUsage = t;
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
    permissionMode: p.permissionMode ?? null,
    ttlRemainingMs: remainingMs,
    ttlStatus: status,
    ttlApproximate: p.backend !== "claude-code",
    alive: p.backend === "claude-code" ? (p.claudeSession ? p.claudeSession.alive : true) : true,
    blocked: (p.lastDenials?.length ?? 0) > 0 || !!p.pendingPermission || !!p.pendingQuestion,
    pendingPermission: p.pendingPermission ?? null,
    pendingQuestion: p.pendingQuestion ?? null,
    totalCostUsd: p.totalCostUsd ?? 0,
    totalUsage: p.totalUsage ?? null,
  };
}

const app = express();
// Default 100kb is enough for plain-text turns but not a turn carrying a
// couple of image/PDF attachments - 25mb covers a handful of typical
// attachments per message without accepting arbitrarily large uploads.
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Lists subdirectories of ?path= (any absolute path, ~ expanded via
 * resolveWorkspaceDir - falls back to DEFAULT_WORKSPACE if omitted, or to
 * the home directory if the requested path doesn't exist/isn't a directory,
 * e.g. the user typed a partial path before clicking Browse). Backs the
 * workspace directory-navigator modal - not scoped to ~/Development, any
 * folder on the filesystem is reachable by navigating up/down from here.
 */
app.get("/api/browse-dir", (req, res) => {
  let dir = req.query.path ? resolveWorkspaceDir(String(req.query.path)) : DEFAULT_WORKSPACE;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = os.homedir();
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? null : parent, entries });
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

app.get("/api/claude-permission-modes", (req, res) => {
  res.json(CLAUDE_PERMISSION_MODES);
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
    const { name, backend, providerID, modelID, permissionMode } = req.body ?? {};
    const workspaceDir = resolveWorkspaceDir(req.body?.workspaceDir);
    if (!name) return res.status(400).json({ error: "name is required" });
    if (backend !== "api" && backend !== "claude-code") {
      return res.status(400).json({ error: 'backend must be "api" or "claude-code"' });
    }
    if (!modelID) return res.status(400).json({ error: "modelID is required" });
    if (permissionMode && !CLAUDE_PERMISSION_MODES.some((m) => m.value === permissionMode)) {
      return res.status(400).json({ error: `unrecognized permissionMode: ${permissionMode}` });
    }
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

      // Concurrent-session git safety (Brian's standing rule), same as the
      // claude-code branch below: an OpenCode persona running bash/git in a
      // shared checkout can collide with Brian's own terminal sessions or
      // other personas on the same repo otherwise. The id passed here is
      // just a throwaway label for worktree/branch naming - the persona's
      // real id comes from OpenCode's own session.create() response below.
      let actualCwd = workspaceDir;
      let isolated = false;
      let worktreeBranch = null;
      if (isGitRepo(workspaceDir)) {
        const wt = createIsolatedWorktree(workspaceDir, name, randomUUID());
        actualCwd = wt.worktreePath;
        isolated = true;
        worktreeBranch = wt.branch;
      }

      const entry = pool.getOrCreate(actualCwd);
      await entry.ready;
      const session = await entry.client.session.create({ body: { title: name } });
      const id = session.data.id;
      persona = {
        id, name, backend, providerID, modelID, workspaceDir, actualCwd, isolated, worktreeBranch,
        sessionID: id,
        opencodeEntry: null,
        lastActivityTs: Date.now(),
        messages: [],
        lastDenials: [],
        pendingPermission: null,
        pendingQuestion: null,
        pendingTurn: null,
      };
      await connectApiPersona(persona, entry);
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

      const claudeSession = new ClaudeCodeSession(id, modelID, name, actualCwd, false, permissionMode || null);
      persona = {
        id, name, backend, modelID, workspaceDir, actualCwd, isolated, worktreeBranch,
        permissionMode: permissionMode || null,
        claudeSession,
        lastActivityTs: Date.now(),
        messages: [],
        lastDenials: [],
        pendingTurn: null,
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

app.get("/api/personas/:id/stream", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  // The user is actively opening this persona - connect (and for api-backend
  // personas, reconcile any permission/question left pending from before a
  // server restart) now rather than staying lazy until the next message,
  // otherwise a persona blocked before a crash shows blocked:false forever.
  await ensureConnected(persona);
  hub.subscribe(persona.id, res);
});

/**
 * Full wind-down, not just a UI hide: stop the actual backend process/
 * session so nothing keeps running or billing after deletion, and clean up
 * every artifact this persona created (worktree, branch, OpenCode session)
 * rather than leaving them orphaned.
 */
app.delete("/api/personas/:id", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });

  if (persona.backend === "claude-code") {
    persona.claudeSession?.kill();
    if (persona.isolated) {
      removeWorktreeAndBranch(persona.workspaceDir, persona.actualCwd, persona.worktreeBranch);
    }
  } else {
    try {
      await ensureConnected(persona); // opencodeEntry may be null if never reconnected since a restart
      await persona.opencodeEntry.client.session.delete({ path: { id: persona.sessionID } });
    } catch (err) {
      console.error(`[delete] failed to delete OpenCode session ${persona.sessionID}:`, err.message);
    }
    if (persona.isolated) {
      removeWorktreeAndBranch(persona.workspaceDir, persona.actualCwd, persona.worktreeBranch);
    }
  }

  personas.delete(persona.id);
  persistAll();
  res.status(204).end();
});

/**
 * Appends a synthetic trailing entry for a turn still in progress (pending:
 * true) so a client that (re)connects mid-turn renders the CURRENT
 * accumulated text instead of nothing - the fix for symposion's "agent
 * dialogue overwriting/losing its previous response" bug: a client that
 * switched away and back (or reloaded) used to only ever see fully-completed
 * turns via this endpoint, so an in-flight turn was either invisible until
 * it finished, or - worse - rendered starting from empty and only capturing
 * whatever deltas happened to arrive AFTER resubscribing, silently dropping
 * everything generated in the gap.
 */
app.get("/api/personas/:id/messages", (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  const messages = persona.pendingTurn
    ? [
        ...persona.messages,
        { role: "assistant", text: persona.pendingTurn.text, parts: persona.pendingTurn.parts, ts: Date.now(), pending: true },
      ]
    : persona.messages;
  res.json(messages);
});

app.post("/api/personas/:id/messages", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  const { text, attachments: rawAttachments } = req.body ?? {};
  if (!text && !(rawAttachments?.length > 0)) return res.status(400).json({ error: "text or attachments required" });

  // rawAttachments (from the client) carries the base64 payload itself -
  // that's what the backend adapters need to build content blocks for THIS
  // turn. attachmentMetas is the persisted, disk-backed form (id/filename/
  // mime/sizeBytes only, no base64) that goes into personas.json and lets
  // the UI re-fetch the bytes later via GET .../attachments/:id - keeping
  // the whole-file JSON store from ballooning with inlined file data.
  const attachments = rawAttachments ?? [];
  let attachmentMetas;
  try {
    // Isolated from the turn's own try/catch below so a malformed upload
    // (bad base64, missing fields) fails BEFORE anything is pushed onto
    // persona.messages - otherwise a bad request would leave a half-formed
    // user turn in history with no attachments and no way to retry cleanly.
    attachmentMetas = attachments.map((a) => saveAttachment(persona.id, a));
  } catch (err) {
    return res.status(400).json({ error: `invalid attachment: ${err.message}` });
  }

  persona.messages.push({ role: "user", text, ts: Date.now(), attachments: attachmentMetas });

  try {
    await ensureConnected(persona);

    let replyText;
    let denials = [];
    let parts = [];
    let costUsd = 0;
    let usage = null;

    persona.pendingTurn = { text: "", parts: [] };
    const onDelta = (chunk) => {
      // Order matters: persist the chunk into pendingTurn.text BEFORE
      // publishing it, since a client's GET .../messages and this SSE
      // publish must agree on exactly which chunks are "in" vs "not yet
      // arrived" - see the GET handler's doc comment above.
      persona.pendingTurn.text += chunk;
      hub.publish(persona.id, { type: "delta", text: chunk });
    };
    // Same order-matters rule as onDelta above, and the same reconnect-safety
    // motivation: without persisting live tool state into pendingTurn.parts,
    // a client that reloads mid-turn (or a turn that never emits any text,
    // e.g. tool-only) shows nothing but the generic thinking indicator for
    // however long the turn runs - no visibility into whether a subagent is
    // actually working or the persona has stalled (symposion "better tool
    // call progress visibility").
    const onToolUpdate = (toolUpdate) => {
      const idx = persona.pendingTurn.parts.findIndex((p) => p.toolUseId === toolUpdate.toolUseId);
      if (idx >= 0) persona.pendingTurn.parts[idx] = toolUpdate;
      else persona.pendingTurn.parts.push(toolUpdate);
      hub.publish(persona.id, { type: "tool", ...toolUpdate });
    };

    if (persona.backend === "api") {
      const result = await promptOpenCodeStreaming(persona, text, attachments, onDelta, onToolUpdate);
      replyText = result.text;
      parts = result.parts;
      costUsd = result.costUsd ?? 0;
      usage = result.usage ?? null;
    } else {
      const result = await persona.claudeSession.sendMessage(text, attachments, onDelta, onToolUpdate);
      replyText = result.replyText;
      denials = result.permissionDenials;
      parts = result.parts;
      costUsd = result.costUsd ?? 0;
      usage = result.usage ?? null;
    }

    persona.pendingTurn = null;
    persona.lastActivityTs = Date.now();
    persona.lastDenials = denials;
    accumulateUsage(persona, costUsd, usage);
    persona.messages.push({
      role: "assistant",
      text: replyText || "(no text response)",
      ts: Date.now(),
      blocked: denials.length > 0,
      denials,
      parts,
      costUsd,
      usage,
    });
    persistAll();
    hub.publish(persona.id, { type: "done", text: replyText, denials, parts, costUsd, usage });

    res.json({ persona: personaSummary(persona), reply: replyText, denials, parts, costUsd, usage });
  } catch (err) {
    persona.pendingTurn = null;
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Serves an uploaded attachment's raw bytes back to the browser (image
// thumbnails, file-chip downloads) without ever re-embedding base64 into the
// polled /messages payload. attachmentFilePath does the traversal-safe path
// resolution (store.mjs) - a 404 here just means an unknown/foreign id, not
// a crash.
app.get("/api/personas/:id/attachments/:attachmentId", (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  const meta = persona.messages.flatMap((m) => m.attachments ?? []).find((a) => a.id === req.params.attachmentId);
  // attachmentFilePath both validates the id (UUID-only) and confirms the
  // file actually exists - a null here means "not found", whether the id is
  // bogus or just belongs to a different persona.
  const exists = meta && attachmentFilePath(persona.id, meta.id);
  if (!exists) return res.status(404).json({ error: "attachment not found" });
  res.setHeader("Content-Type", meta.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(meta.filename ?? meta.id)}"`);
  // { root } (rather than the absolute path directly) matters beyond
  // convenience: Express's sendFile applies its default dotfile rejection to
  // EVERY segment of an absolute path, including symposion's own install
  // path - a dotted directory anywhere upstream (`.claude/worktrees/...`,
  // `~/.config/...`, an iCloud-synced folder) would 404 a perfectly valid
  // attachment. Scoping to `root` means only the relative `personaId/id`
  // portion is checked, and both are plain UUIDs - never dotted.
  res.sendFile(path.join(persona.id, meta.id), { root: ATTACHMENTS_DIR });
});

/**
 * Resolve a pending permission request. persona.pendingPermission is cleared
 * by the "permission.replied" event handler in connectApiPersona (single
 * source of truth), not here - this endpoint only submits the reply.
 */
app.post("/api/personas/:id/permission-reply", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  if (persona.backend !== "api") return res.status(400).json({ error: "only api-backend personas have permission requests" });
  const { reply } = req.body ?? {};
  if (!["once", "always", "reject"].includes(reply)) {
    return res.status(400).json({ error: 'reply must be "once", "always", or "reject"' });
  }
  try {
    // Connect (and reconcile) BEFORE checking pendingPermission - a request
    // left pending across a server restart only shows up in memory once
    // connectApiPersona's reconciliation has run.
    await ensureConnected(persona);
    if (!persona.pendingPermission) return res.status(400).json({ error: "no pending permission request" });
    const result = await persona.opencodeEntry.client.postSessionIdPermissionsPermissionId({
      path: { id: persona.sessionID, permissionID: persona.pendingPermission.id },
      body: { response: reply },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/** Resolve a pending question request, either with answers or a rejection. */
app.post("/api/personas/:id/question-reply", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  if (persona.backend !== "api") return res.status(400).json({ error: "only api-backend personas have question requests" });
  const { answers, reject } = req.body ?? {};
  try {
    await ensureConnected(persona);
    if (!persona.pendingQuestion) return res.status(400).json({ error: "no pending question request" });
    const { port } = persona.opencodeEntry;
    if (reject) {
      await pool.rejectQuestion(port, persona.pendingQuestion.id);
    } else {
      if (!Array.isArray(answers)) return res.status(400).json({ error: "answers array is required (or set reject:true)" });
      await pool.replyQuestion(port, persona.pendingQuestion.id, answers);
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.SYMPOSION_PORT || 5173;
// Bind explicitly to loopback - omitting the host binds ALL interfaces by
// default (confirmed live: `lsof -iTCP:5173` showed `TCP *:5173`), meaning
// anyone else on the same network (e.g. an Airbnb guest on the same WiFi)
// could reach this zero-auth server and read/send-as/delete any persona.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`symposion MVP listening on http://127.0.0.1:${PORT}`);
});
