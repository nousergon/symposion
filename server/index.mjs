import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { ClaudeCodeSession, CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, CLAUDE_EFFORT_LEVELS, CLAUDE_BIN } from "./claude-code-backend.mjs";
import { ensureWorkspaceTrusted, startRemoteControl, stopRemoteControl, isProcessAlive, importRemoteTurns } from "./remote-control.mjs";
import { OpenCodeServerPool } from "./opencode-pool.mjs";
import { loadPersonas, savePersonas, toRecord, saveAttachment, attachmentFilePath, ATTACHMENTS_DIR, loadSettings, saveSettings, addPushSubscription, getPushSubscriptions, removePushSubscription } from "./store.mjs";
import { getVapidPublicKey, sendPush } from "./webpush.mjs";
import { createPresenceTracker } from "./presence.mjs";
import { isGitRepo, createIsolatedWorktree, removeWorktreeAndBranch } from "./worktree.mjs";
import { randomStarName } from "./star-names.mjs";
import { SseHub } from "./sse-hub.mjs";
import { resolveSecret } from "./secrets.mjs";
import { ensureEgressProxy } from "./llm-egress-proxy.mjs";
import { fetchQueue, itemToQuestion, postComment, removeLabels, addLabels, closeIssue, markPrReadyForReview } from "./decision-queue.mjs";

import { loadRepoContext } from "./repo-context.mjs";

const hub = new SseHub();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.join(os.homedir(), "Development");

// Every direct-API provider (i.e. every OpenCode provider that isn't the
// free OpenCode Zen proxy) gets its own local content-scanning egress proxy
// instance (llm-egress-proxy.mjs / ~/Development/.llm-routing/llm_egress_
// proxy.py) instead of talking to the real upstream directly. Ports are
// assigned here and must stay stable across restarts (OpenCode's own
// provider config, ~/.config/opencode/opencode.jsonc, machine-local, points
// each provider's baseURL at the matching port with a placeholder apiKey -
// see llm-egress-proxy.mjs's module doc). deepseek=8972 predates this map
// (symposion#6); xai=8973 added 2026-07-19 when a real xAI account was
// wired up the same way, generalizing what used to be a DeepSeek-only path;
// gemini=8974 added 2026-07-23 for Gemini models via Google's OpenAI-
// compatible endpoint (generativelanguage.googleapis.com/v1beta/openai).
const EGRESS_PROXY_PROVIDERS = {
  deepseek: { port: 8972, upstreamHost: "api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", upstreamPrefix: "" },
  xai: { port: 8973, upstreamHost: "api.x.ai", apiKeyEnv: "XAI_API_KEY", upstreamPrefix: "" },
  gemini: { port: 8974, upstreamHost: "generativelanguage.googleapis.com", apiKeyEnv: "GEMINI_API_KEY", upstreamPrefix: "/v1beta/openai" },
};

// Resolved once at startup (env override, else SSM /symposion/{KEY}) and
// handed ONLY to the corresponding local egress proxy process, never to
// symposion's own process.env or an `opencode serve` child's env - the
// real key never reaches an unscanned outbound request (symposion#6,
// generalized to non-DeepSeek providers 2026-07-19). Missing key, or the
// proxy failing to come up, just means that provider silently doesn't
// work - not startup-fatal, since the free opencode-zen proxy still works
// either way.
const providerKeys = {};
for (const [providerId, cfg] of Object.entries(EGRESS_PROXY_PROVIDERS)) {
  const key = await resolveSecret(cfg.apiKeyEnv);
  providerKeys[providerId] = key;
  if (key) await ensureEgressProxy({ providerId, apiKey: key, ...cfg });
  else console.warn(`[secrets] ${cfg.apiKeyEnv} not found (env or SSM) - real ${providerId} account provider will not be available`);
}

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

// See presence.mjs for what this tracks and why - in short, it's what lets
// notifyTurnFinished below fire only when Brian isn't already watching the
// persona that just replied, instead of pushing on every single turn.
const presence = createPresenceTracker();

/**
 * Fire-and-forget Web Push fan-out for a turn that just finished - see
 * presence.mjs for why this only fires when the finishing persona isn't the
 * one Brian's actively watching. Never awaited by the caller (same pattern
 * as updateSummary below): a push failure or a slow push-service round-trip
 * must never delay the turn's own HTTP response.
 */
async function notifyTurnFinished(persona, replyText) {
  if (presence.isWatching(persona.id)) return;
  const subs = getPushSubscriptions();
  if (subs.length === 0) return;
  const payload = {
    title: `${persona.name} replied`,
    body: (replyText || "").slice(0, 200),
    tag: "symposion-turn-done",
  };
  await Promise.all(subs.map(async (sub) => {
    const { expired } = await sendPush(sub, payload);
    if (expired) removePushSubscription(sub.endpoint);
  }));
}

for (const record of loadPersonas()) {
  personas.set(record.id, {
    ...record,
    claudeSession: null,
    opencodeEntry: null,
    pendingPermission: null,
    pendingQuestion: null,
    pendingTurn: null,
    backgroundTask: null,
    turnFinishedUnseen: false,
  });
}
console.log(`[store] loaded ${personas.size} persona(s) from disk`);

// Persisted server-side (not localStorage) so the "last recipe" default
// survives a browser cache clear and is consistent across any device that
// hits this box (e.g. phone via Remote Control) - not just the one browser
// that happened to create the last persona.
const settings = loadSettings();
let lastRecipe = settings.lastRecipe ?? null;

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

/**
 * Wires a freshly-constructed ClaudeCodeSession's onBackgroundEvent callback
 * to this persona's backgroundTask state + SSE stream. Must be called every
 * time a new ClaudeCodeSession is constructed (both call sites: fresh
 * persona creation, and ensureConnected's reconnect-after-restart path) -
 * the session itself has no persona reference to self-wire.
 */
function wireBackgroundEvents(persona) {
  persona.claudeSession.onBackgroundEvent = ({ status, parts }) => {
    persona.backgroundTask =
      status === "done" ? null : { parts, startedAt: persona.backgroundTask?.startedAt ?? Date.now() };
    hub.publish(persona.id, { type: "background", status, parts });
  };
}

/** Lazily (re)connect a persona's backend process/session after a restart. */
async function ensureConnected(persona) {
  if (persona.backend === "claude-code") {
    // While handed off to Remote Control, the interactive claude process IS
    // the session - respawning the -p subprocess here would put two live
    // writers on the same session id. Hard-stop instead; callers that can
    // tolerate a handed-off persona (the SSE stream route) check first.
    if (persona.handoff) throw new Error("persona is handed off to Remote Control - reclaim it before messaging");
    if (persona.claudeSession && persona.claudeSession.alive) return;
    const resuming = persona.messages.length > 0;
    // Reconnect to the SAME worktree/cwd used originally - never re-derive
    // or re-create one on reconnect, or every restart would leak a new
    // worktree+branch for the same persona.
    persona.claudeSession = new ClaudeCodeSession(persona.id, persona.modelID, persona.name, persona.actualCwd, resuming, persona.permissionMode, persona.effortLevel);
    wireBackgroundEvents(persona);
  } else {
    // Runs on every call, not just first-connect: an egress proxy is a
    // separate process from the opencode pool entry below, so it can die
    // independently AFTER a persona is already connected (verified live,
    // symposion#24 - a manually-killed proxy left every subsequent message
    // to a "deepseek"-provider persona hanging forever with no error
    // surfaced, since ensureEgressProxy() previously only ran once at
    // server startup). ensureEgressProxy() itself is a cheap
    // health-check-first, spawn-if-not-running call - negligible cost when
    // the proxy's already healthy, the common case.
    const egressProxyCfg = EGRESS_PROXY_PROVIDERS[persona.providerID];
    if (egressProxyCfg && providerKeys[persona.providerID]) {
      await ensureEgressProxy({ providerId: persona.providerID, apiKey: providerKeys[persona.providerID], ...egressProxyCfg });
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

    const cwd = persona.actualCwd ?? persona.workspaceDir;
    const repoContext = loadRepoContext(cwd);
    const systemPrompt = [
      `Your name is ${persona.name}. If asked your name or who you are, identify yourself as ${persona.name}.`,
      repoContext ? `\n── Repository context (${cwd}) ──\n\n${repoContext}` : "",
    ].filter(Boolean).join("");

    client.session
      .promptAsync({
        path: { id: persona.sessionID },
        body: {
          model: { providerID: persona.providerID, modelID: persona.modelID },
          system: systemPrompt,
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

/**
 * Refreshes a persona's 1-2 sentence "what's being discussed" summary,
 * shown at the top of its chat. Deliberately independent of the persona's
 * OWN backend/session - it runs as a throwaway one-shot prompt against a
 * scratch OpenCode session in DEFAULT_WORKSPACE using the cheap API_DEFAULT
 * model (the same pool.getOrCreate(DEFAULT_WORKSPACE) pattern /api/providers
 * already uses), so it works identically for claude-code-backed personas
 * (which have no opencodeEntry of their own) without perturbing the
 * persona's real conversation history or cost/token totals.
 *
 * Fire-and-forget from the caller's perspective: every failure path is
 * caught and logged here, never rethrown, since a summary is a nice-to-have
 * that must never affect the actual chat turn it runs alongside.
 */
async function updateSummary(persona) {
  if (persona._summarizing) return;
  if (persona.messages.length < 2) return; // wait for at least one full exchange
  persona._summarizing = true;
  let sessionId;
  try {
    const entry = pool.getOrCreate(DEFAULT_WORKSPACE);
    await entry.ready;
    const session = await entry.client.session.create({ body: { title: `summary-scratch-${persona.id}` } });
    sessionId = session.data.id;

    // Last 16 turns is plenty of context for a 1-2 sentence gist and keeps
    // the scratch prompt small/cheap regardless of how long the real chat gets.
    const transcript = persona.messages
      .slice(-16)
      .map((m) => `${m.role}: ${(m.text || "").slice(0, 800)}`)
      .join("\n");

    const result = await entry.client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: API_DEFAULT.providerID, modelID: API_DEFAULT.modelID },
        system:
          "You summarize chat transcripts. Reply with ONLY a plain 1-2 sentence summary of what is being discussed - no preamble, no quotes, no markdown.",
        parts: [{ type: "text", text: transcript }],
      },
    });

    const text = (result.data?.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();

    if (text) {
      persona.summary = text;
      persistAll();
      hub.publish(persona.id, { type: "summary", text });
    }
  } catch (err) {
    console.error(`[summary] failed for persona ${persona.id}:`, err.message);
  } finally {
    persona._summarizing = false;
    if (sessionId) {
      try {
        await pool.getOrCreate(DEFAULT_WORKSPACE).client.session.delete({ path: { id: sessionId } });
      } catch {
        // Best-effort scratch-session cleanup only - a leaked throwaway
        // session in DEFAULT_WORKSPACE costs nothing and isn't worth retrying.
      }
    }
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
    effortLevel: p.effortLevel ?? null,
    ttlRemainingMs: remainingMs,
    ttlStatus: status,
    ttlApproximate: p.backend !== "claude-code",
    alive: p.backend === "claude-code" ? (p.claudeSession ? p.claudeSession.alive : true) : true,
    blocked: (p.lastDenials?.length ?? 0) > 0 || !!p.pendingPermission || !!p.pendingQuestion,
    working: !!p.pendingTurn,
    // True from the moment a turn finishes while Brian wasn't watching this
    // persona (same presence gate as notifyTurnFinished below) until he
    // actually selects it again (cleared in POST /api/presence) - the
    // "come look, this one finished" signal that used to not exist: a
    // persona that just replied and one that's never spoken were previously
    // visually identical (both idle/grey) once `working` went false.
    readyForReview: !!p.turnFinishedUnseen,
    // Distinct from `working` (foreground pendingTurn): true when a detached
    // background dispatch (e.g. a run_in_background Agent-tool subagent) is
    // still running after the turn that launched it already ended - see
    // wireBackgroundEvents/ClaudeCodeSession.onBackgroundEvent (symposion-I45).
    backgroundActive: !!p.backgroundTask,
    backgroundParts: p.backgroundTask?.parts ?? null,
    // See ClaudeCodeSession._updateScheduledWakeup - null for opencode-backed
    // personas (no claudeSession) or a claude-code persona with no pending
    // /loop wakeup.
    scheduledWakeup: p.claudeSession?.scheduledWakeup ?? null,
    pendingPermission: p.pendingPermission ?? null,
    pendingQuestion: p.pendingQuestion ?? null,
    totalCostUsd: p.totalCostUsd ?? 0,
    totalUsage: p.totalUsage ?? null,
    // Auto-generated 1-2 sentence "what's being discussed" summary - see
    // updateSummary(). null until the first exchange completes.
    summary: p.summary ?? null,
    // alive is computed per-request (not stored) so a remote-control process
    // that died on its own (phone session ended, reboot) shows up as such in
    // the UI without any event plumbing from the detached process.
    handoff: p.handoff
      ? { url: p.handoff.url, startedAt: p.handoff.startedAt, alive: isProcessAlive(p.handoff.pid) }
      : null,
  };
}

/**
 * Shared persona creation from a validated recipe — extracted from the
 * POST /api/personas handler so quick-agent launches (and any future
 * programmatic creation path) reuse the same worktree/OpenCode/
 * ClaudeCodeSession/booking logic rather than duplicating ~80 lines of
 * backend-specific setup. Does NOT do input validation (callers validate
 * before calling) so the function signature stays clean: every field is
 * required and pre-validated.
 *
 * workspaceDir is the REAL (user-facing) workspace — the function handles
 * worktree isolation internally, setting actualCwd/isolated/worktreeBranch
 * on the persona for any git repo automatically, same as the original handler.
 */
async function createPersonaFromRecipe({ backend, providerID, modelID, permissionMode, effortLevel, workspaceDir, name }) {
  let persona;
  if (backend === "api") {
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
      summary: null,
      lastDenials: [],
      pendingPermission: null,
      pendingQuestion: null,
      pendingTurn: null,
      turnFinishedUnseen: false,
      backgroundTask: null,
    };
    await connectApiPersona(persona, entry);
  } else {
    const id = randomUUID();

    let actualCwd = workspaceDir;
    let isolated = false;
    let worktreeBranch = null;
    if (isGitRepo(workspaceDir)) {
      const wt = createIsolatedWorktree(workspaceDir, name, id);
      actualCwd = wt.worktreePath;
      isolated = true;
      worktreeBranch = wt.branch;
    }

    const claudeSession = new ClaudeCodeSession(id, modelID, name, actualCwd, false, permissionMode || null, effortLevel || null);
    persona = {
      id, name, backend, modelID, workspaceDir, actualCwd, isolated, worktreeBranch,
      permissionMode: permissionMode || null,
      effortLevel: effortLevel || null,
      claudeSession,
      lastActivityTs: Date.now(),
      messages: [],
      summary: null,
      lastDenials: [],
      pendingTurn: null,
      backgroundTask: null,
      turnFinishedUnseen: false,
    };
    wireBackgroundEvents(persona);
  }

  personas.set(persona.id, persona);
  persistAll();

  // Same lastRecipe update as the original POST handler — the next New Agent
  // modal open remembers this recipe regardless of whether it came from the
  // modal itself or a quick-agent launch (the last thing Brian created).
  lastRecipe = { backend, providerID: providerID ?? null, modelID, permissionMode: permissionMode ?? null, effortLevel: effortLevel ?? null };
  settings.lastRecipe = lastRecipe;
  saveSettings(settings);

  return persona;
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

app.get("/api/claude-effort-levels", (req, res) => {
  res.json(CLAUDE_EFFORT_LEVELS);
});

app.get("/api/defaults", (req, res) => {
  res.json({ apiDefault: API_DEFAULT, claudeCodeDefault: CLAUDE_CODE_DEFAULT, defaultWorkspace: DEFAULT_WORKSPACE, lastRecipe });
});

/**
 * A fresh random star name, excluding names already in use by a live
 * persona - backs the "New Agent" modal's auto-filled name field and its
 * dice/regenerate button, so nobody has to type a name to create a persona.
 */
app.get("/api/random-name", (req, res) => {
  res.json({ name: randomStarName([...personas.values()].map((p) => p.name)) });
});

app.get("/api/webpush/vapid-public-key", async (req, res) => {
  const publicKey = await getVapidPublicKey();
  if (!publicKey) return res.status(404).json({ error: "web push not configured" });
  res.json({ publicKey });
});

// Body is the browser's raw PushSubscription.toJSON() object - stored
// verbatim, deduped by endpoint (see store.mjs's addPushSubscription).
app.post("/api/webpush/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "invalid PushSubscription" });
  }
  addPushSubscription(subscription);
  res.status(204).end();
});

// Client presence heartbeat - see the `presence`/isBeingWatched doc comment
// above for what this drives. personaId: null means "not currently
// watching anything" (tab hidden/unfocused, or no persona selected).
app.post("/api/presence", (req, res) => {
  const personaId = req.body?.personaId;
  presence.update(personaId);
  // Watching a persona is what "reviewing" it means here - clear its
  // ready-for-review flag the moment Brian's actually looking at it again.
  if (personaId) {
    const persona = personas.get(personaId);
    if (persona) persona.turnFinishedUnseen = false;
  }
  res.status(204).end();
});

/**
 * Restarts the server process in place, so a UI button can pick up a fresh
 * `git pull` without needing Activity Monitor / launchctl. Relies entirely
 * on the LaunchAgent's KeepAlive:true (com.nousergon.symposion.plist) to
 * respawn - same "any exit is a crash to recover from" contract the
 * documented `launchctl kickstart -k` / kill / pkill restart paths already
 * rely on (see infra/README.md), so this introduces no new failure mode.
 * Responds before exiting so the fetch resolves; the frontend then polls
 * /api/defaults until the fresh process answers and reloads the page.
 */
app.post("/api/server/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 150);
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
    const { backend, providerID, modelID, permissionMode, effortLevel } = req.body ?? {};
    // A name is never required to create a persona - an untyped/blank field
    // just gets a random star name, excluding whatever's already in use.
    const name = (req.body?.name ?? "").trim() || randomStarName([...personas.values()].map((p) => p.name));
    const workspaceDir = resolveWorkspaceDir(req.body?.workspaceDir);
    if (backend !== "api" && backend !== "claude-code") {
      return res.status(400).json({ error: 'backend must be "api" or "claude-code"' });
    }
    if (!modelID) return res.status(400).json({ error: "modelID is required" });
    if (permissionMode && !CLAUDE_PERMISSION_MODES.some((m) => m.value === permissionMode)) {
      return res.status(400).json({ error: `unrecognized permissionMode: ${permissionMode}` });
    }
    if (effortLevel && !CLAUDE_EFFORT_LEVELS.some((m) => m.value === effortLevel)) {
      return res.status(400).json({ error: `unrecognized effortLevel: ${effortLevel}` });
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
    if (backend === "api" && !providerID) {
      return res.status(400).json({ error: "providerID is required for backend=api" });
    }

    const persona = await createPersonaFromRecipe({ backend, providerID, modelID, permissionMode, effortLevel, workspaceDir, name });
    res.status(201).json(personaSummary(persona));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/* ── Quick Agents (one-click chip presets) ── */

app.get("/api/quick-agents", (req, res) => {
  const s = loadSettings();
  res.json(s.quickAgents ?? []);
});

app.post("/api/quick-agents", (req, res) => {
  const { label, backend, providerID, modelID, permissionMode, effortLevel } = req.body ?? {};
  if (!label?.trim()) return res.status(400).json({ error: "label is required" });
  if (!backend || (backend !== "api" && backend !== "claude-code")) {
    return res.status(400).json({ error: 'backend must be "api" or "claude-code"' });
  }
  if (!modelID) return res.status(400).json({ error: "modelID is required" });
  if (backend === "api" && !providerID) {
    return res.status(400).json({ error: "providerID is required for backend=api" });
  }
  if (permissionMode && !CLAUDE_PERMISSION_MODES.some((m) => m.value === permissionMode)) {
    return res.status(400).json({ error: `unrecognized permissionMode: ${permissionMode}` });
  }
  if (effortLevel && !CLAUDE_EFFORT_LEVELS.some((m) => m.value === effortLevel)) {
    return res.status(400).json({ error: `unrecognized effortLevel: ${effortLevel}` });
  }

  const s = loadSettings();
  const qa = { id: randomUUID(), label: label.trim(), backend, providerID: providerID ?? null, modelID, permissionMode: permissionMode ?? null, effortLevel: effortLevel ?? null };
  s.quickAgents = [...(s.quickAgents ?? []), qa];
  saveSettings(s);
  res.status(201).json(qa);
});

app.patch("/api/quick-agents/:id", (req, res) => {
  const { label } = req.body ?? {};
  if (!label?.trim()) return res.status(400).json({ error: "label is required" });

  const s = loadSettings();
  const idx = (s.quickAgents ?? []).findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "quick agent not found" });

  s.quickAgents[idx] = { ...s.quickAgents[idx], label: label.trim() };
  saveSettings(s);
  res.json(s.quickAgents[idx]);
});

app.delete("/api/quick-agents/:id", (req, res) => {
  const s = loadSettings();
  const idx = (s.quickAgents ?? []).findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "quick agent not found" });

  s.quickAgents.splice(idx, 1);
  saveSettings(s);
  res.status(204).end();
});

app.post("/api/quick-agents/:id/launch", async (req, res) => {
  try {
    const s = loadSettings();
    const qa = (s.quickAgents ?? []).find((a) => a.id === req.params.id);
    if (!qa) return res.status(404).json({ error: "quick agent not found" });

    const name = randomStarName([...personas.values()].map((p) => p.name));
    const persona = await createPersonaFromRecipe({
      backend: qa.backend,
      providerID: qa.providerID,
      modelID: qa.modelID,
      permissionMode: qa.permissionMode,
      effortLevel: qa.effortLevel,
      // Quick agents carry a model recipe, not a workspace — same reasoning
      // PR43 used to exclude workspace from lastRecipe: Brian launches quick
      // agents from any context, so DEFAULT_WORKSPACE is the right default.
      workspaceDir: DEFAULT_WORKSPACE,
      name,
    });
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
  // A handed-off persona deliberately skips connecting (its live session is
  // the Remote Control process, not ours) but still gets the SSE
  // subscription so the reclaim event reaches this client.
  if (!persona.handoff) await ensureConnected(persona);
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
    // A handed-off persona's live process is the detached remote-control
    // pair, not claudeSession - kill it too or deleting the persona would
    // leave a phone-controllable session running in a just-removed worktree.
    if (persona.handoff) stopRemoteControl(persona.handoff.pid);
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
 * Renames a persona and/or switches its model - both possible at any time,
 * not just at creation. Cosmetic everywhere (sidebar/header/storage) updates
 * immediately here. Identity (the model's own belief about its name) updates
 * on different timelines per backend: an api-backend (OpenCode) persona
 * resends its system prompt fresh on every single message (see
 * promptOpenCodeStreaming's `system:` line below), so it picks up the new
 * name on the very next turn; a claude-code persona's identity is baked into
 * --append-system-prompt once at process spawn (claude-code-backend.mjs), so
 * it only self-identifies under the new name after its next reconnect/resume
 * - respawning it here to force an immediate update would kill whatever turn
 * might be in flight.
 *
 * Model/provider switch follows the same asymmetry, for the same reason
 * promptOpenCodeStreaming/ClaudeCodeSession are shaped the way they are:
 * an api-backend persona reads persona.modelID/providerID fresh on every
 * turn (same `system:` line above), so just writing the new fields here is
 * enough - no respawn, and ensureConnected() re-checks the target provider's
 * egress proxy on every message regardless of connection state, so a
 * provider switch (e.g. deepseek -> xai) needs nothing further either. A
 * claude-code persona's model is pinned into the CLI subprocess at spawn
 * (ClaudeCodeSession's constructor), so switching it requires killing the
 * live session and respawning it via the exact same resume-by-message-
 * history path ensureConnected() already uses to reconnect after a server
 * restart - done synchronously here (not deferred to the next message)
 * specifically so personaSummary().alive doesn't flash a misleading
 * "(crashed)" state in the sidebar between this response and the next turn.
 * Never done mid-turn (pendingTurn guard below) or while handed off to
 * Remote Control (that live process, not claudeSession, is the session -
 * same rule ensureConnected/the handoff endpoint already enforce).
 *
 * effortLevel (claude-code only - no api-backend equivalent exists today)
 * follows the identical pinned-at-spawn/kill+respawn path as model, for the
 * same reason: it's baked into the CLI subprocess via --effort at spawn
 * time, so changing it needs the same respawn as a model switch, gated by
 * the same pendingTurn/handoff checks.
 */
app.patch("/api/personas/:id", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  const modelID = req.body?.modelID;
  const providerID = req.body?.providerID;
  const effortLevel = req.body?.effortLevel;
  const modelChanged = !!modelID && modelID !== persona.modelID;
  const providerChanged = persona.backend === "api" && !!providerID && providerID !== persona.providerID;
  const effortChanged = persona.backend === "claude-code" && effortLevel !== undefined && (effortLevel || null) !== (persona.effortLevel || null);
  const needsRespawn = persona.backend === "claude-code" && (modelChanged || effortChanged);

  if (persona.backend === "api" && modelChanged && !providerID) {
    return res.status(400).json({ error: "providerID is required when changing model for an api-backend persona" });
  }
  if (effortLevel && !CLAUDE_EFFORT_LEVELS.some((m) => m.value === effortLevel)) {
    return res.status(400).json({ error: `unrecognized effortLevel: ${effortLevel}` });
  }
  if (needsRespawn) {
    if (persona.pendingTurn) {
      return res.status(409).json({ error: "a turn is still in flight - wait for it to finish before changing the model or effort" });
    }
    if (persona.handoff) {
      return res.status(409).json({ error: "persona is handed off to Remote Control - reclaim it before changing the model or effort" });
    }
  }

  persona.name = name;
  if (effortChanged) persona.effortLevel = effortLevel || null;
  if (modelChanged || providerChanged) {
    persona.modelID = modelID;
    if (persona.backend === "api") persona.providerID = providerID;
  }
  if (needsRespawn) {
    try {
      if (persona.claudeSession?.alive) persona.claudeSession.kill();
      await ensureConnected(persona);
    } catch (err) {
      console.error(`[model-switch:${persona.id}] failed to respawn with new model/effort:`, err);
      return res.status(500).json({ error: `model/effort switch failed: ${err.message}` });
    }
  }
  persistAll();

  if (persona.backend === "api" && persona.opencodeEntry) {
    try {
      await persona.opencodeEntry.client.session.update({ path: { id: persona.sessionID }, body: { title: name } });
    } catch (err) {
      console.error(`[rename:${persona.id}] failed to update OpenCode session title:`, err.message);
    }
  }

  hub.publish(persona.id, { type: "renamed", name });
  res.json(personaSummary(persona));
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
  if (persona.handoff) {
    return res.status(409).json({ error: "persona is handed off to Remote Control - reclaim it before messaging from here" });
  }

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
    // Same "was Brian actually watching this one" gate as notifyTurnFinished
    // below - no point flagging a reply as needing review when it just
    // rendered live in front of him.
    persona.turnFinishedUnseen = !presence.isWatching(persona.id);
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
    // Fire-and-forget: never await, and never let this delay the turn's own
    // response - see updateSummary's doc comment for why it's safe to ignore.
    updateSummary(persona);
    notifyTurnFinished(persona, replyText);

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
 * Hands a claude-code persona's session off to Anthropic's Remote Control:
 * kills our own -p subprocess (single-writer rule - the interactive process
 * about to spawn takes over the session id), marks the worktree trusted
 * (interactive mode enforces the workspace-trust gate that -p skips), and
 * spawns `claude --resume <id> --remote-control` under a pty, resolving with
 * the claude.ai URL to continue the session from the Claude mobile/web apps.
 * Idempotent: a second call while already handed off (and the process still
 * alive) just returns the existing URL.
 */
app.post("/api/personas/:id/handoff", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  if (persona.backend !== "claude-code") {
    return res.status(400).json({ error: "only claude-code personas can be handed off to Remote Control" });
  }
  if (persona.pendingTurn) {
    return res.status(409).json({ error: "a turn is still in flight - wait for it to finish before handing off" });
  }
  if (persona.handoff) {
    if (isProcessAlive(persona.handoff.pid)) {
      return res.json({ handoff: personaSummary(persona).handoff });
    }
    // Process died while handed off (phone session ended, reboot) - treat as
    // a fresh handoff but KEEP the original startedAt so the turns from the
    // dead handoff still get imported at the eventual reclaim.
    stopRemoteControl(persona.handoff.pid);
  }

  try {
    const priorStartedAt = persona.handoff?.startedAt;
    persona.claudeSession?.kill();
    persona.claudeSession = null;
    ensureWorkspaceTrusted(persona.actualCwd);
    const { pid, url } = await startRemoteControl({
      claudeBin: CLAUDE_BIN,
      sessionId: persona.id,
      cwd: persona.actualCwd,
      model: persona.modelID,
      personaName: persona.name,
      permissionMode: persona.permissionMode,
    });
    persona.handoff = { url, pid, startedAt: priorStartedAt ?? Date.now() };
    persistAll();
    hub.publish(persona.id, { type: "handoff", state: "active", handoff: personaSummary(persona).handoff });
    res.json({ handoff: personaSummary(persona).handoff });
  } catch (err) {
    console.error(`[handoff:${persona.id}]`, err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Reclaims a handed-off persona: stops the remote-control process, imports
 * the turns that happened remotely from the on-disk transcript into
 * symposion's own message history, and clears the handoff - the next message
 * (or stream open) lazily respawns the normal -p subprocess via
 * ensureConnected, which --resumes the same session including everything
 * done from the phone.
 */
app.post("/api/personas/:id/reclaim", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  if (!persona.handoff) return res.status(400).json({ error: "persona is not handed off" });

  stopRemoteControl(persona.handoff.pid);

  let imported = [];
  let importError = null;
  try {
    imported = importRemoteTurns(persona.actualCwd, persona.id, persona.handoff.startedAt);
  } catch (err) {
    // Swallowed (recorded here + surfaced in the response) rather than
    // re-thrown: failing the whole reclaim would strand the persona in
    // handed-off state with its process already killed - unusable from both
    // sides. The conversation itself is safe either way: claude's own
    // transcript still has every turn, only symposion's chat view is missing
    // the remote ones.
    console.error(`[reclaim:${persona.id}] transcript import failed:`, err);
    importError = String(err);
  }
  persona.messages.push(...imported);
  persona.handoff = null;
  if (imported.length > 0) persona.lastActivityTs = Date.now();
  persistAll();
  hub.publish(persona.id, { type: "handoff", state: "reclaimed", importedCount: imported.length });
  res.json({ persona: personaSummary(persona), importedCount: imported.length, importError });
});

/**
 * QR code (PNG) for the active handoff's URL, so "continue on your phone" is
 * a camera point, not a URL retype. Rendered server-side to keep the
 * frontend dependency-free.
 */
app.get("/api/personas/:id/handoff-qr", async (req, res) => {
  const persona = personas.get(req.params.id);
  if (!persona) return res.status(404).json({ error: "not found" });
  if (!persona.handoff) return res.status(404).json({ error: "persona is not handed off" });
  try {
    const png = await QRCode.toBuffer(persona.handoff.url, { type: "png", width: 220, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
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

/**
 * Fetches all items currently in the decision queue (triage:session, gate:* issues
 * and PRs) and returns them as a list of question-shaped blocks the client can
 * feed into its existing blocked-card / question rendering, one at a time.
 */
app.get("/api/decision-queue", async (req, res) => {
  try {
    const items = await fetchQueue();
    const questions = items.map(itemToQuestion).flat();
    res.json({ count: items.length, items, questions });
  } catch (err) {
    console.error("[decision-queue]", err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Posts a ruling on a triage item: writes an operator-decision comment, strips
 * gate:* and triage:session labels, and (for wontfix) closes the issue.
 * Body: { repo, number, isPr, ruling, comment? }
 * ruling: "approve" | "changes" | "defer" | "wontfix" | "milestone"
 */
app.post("/api/decision-queue/ruling", async (req, res) => {
  try {
    const { repo, number, isPr, ruling, comment } = req.body ?? {};
    if (!repo || !number || !ruling) {
      return res.status(400).json({ error: "repo, number, and ruling are required" });
    }

    const date = new Date().toISOString().slice(0, 10);
    let body = `**Operator decision ${date}: ${ruling}**`;

    if (comment) body += `\n\n${comment}`;
    await postComment(repo, number, body);

    // Strip triage + gate labels
    const stripLabels = ["triage:session", "gate:operator", "gate:decision", "gate:device", "gate:date", "gate:dependency", "gate:milestone"];
    await removeLabels(repo, number, stripLabels);

    if (ruling === "wontfix") {
      await closeIssue(repo, number);
    } else if (ruling === "approve" && isPr) {
      // If this is a PR and it's still a draft, mark it ready for review
      await markPrReadyForReview(repo, number);
    }

    // Add ruling label for traceability
    await addLabels(repo, number, [`ruling:${ruling}`]);

    res.json({ ok: true });
  } catch (err) {
    console.error("[decision-queue/ruling]", err);
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
