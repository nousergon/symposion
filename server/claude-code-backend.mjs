import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Persistent claude -p subprocess per persona, keyed off the empirical
// findings from the symposion spikes:
//  - stream-json in/out survives multiple turns on one live process
//    (no --resume / respawn needed between messages)
//  - there is NO live permission pause in headless mode - a blocked action
//    shows up as a non-empty `permission_denials` array on the turn's
//    `result` event, after the fact, not as a mid-turn prompt
//  - --output-format stream-json requires --verbose alongside --print

// Resolved via direct filesystem checks, not PATH lookup - confirmed live
// (2026-07-15) that launchd's LaunchAgent environment has a minimal PATH
// (set in infra/com.nousergon.symposion.plist) that doesn't include
// wherever `claude` actually lives, causing `spawn("claude", ...)` to fail
// with ENOENT under supervision even though it works fine in an interactive
// terminal. Checking known install locations directly sidesteps needing
// `which`/PATH resolution to work correctly in the first place - the
// plist's PATH was also fixed to include the confirmed real location, but
// this is the actual root-cause fix: don't depend on PATH-based binary
// resolution for a subprocess spawn in an environment-sensitive context.
function resolveClaudeBinary() {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude"; // last resort - PATH-based lookup, same as before this fix
}
export const CLAUDE_BIN = resolveClaudeBinary();

export const CLAUDE_MODELS = [
  { modelID: "claude-sonnet-5", name: "Sonnet 5" },
  { modelID: "claude-opus-4-8", name: "Opus 4.8" },
  { modelID: "claude-haiku-4-5", name: "Haiku 4.5" },
  { modelID: "claude-fable-5", name: "Fable 5" },
];

// The claude CLI's own --permission-mode choices (verified via `claude
// --help`), minus "bypassPermissions" - deliberately not offered here since
// it disables the approval gate entirely (fully autonomous, no denials to
// even review); picking that is a bigger decision than a persona-creation
// dropdown should make casual. null/omitted means "let the CLI pick its own
// default" rather than symposion hardcoding an assumption about what that
// default is - confirmed empirically (2026-07-15, symposion#3) that it
// currently resolves to "auto" (the mode that engages Claude Code's own
// auto-mode allow/soft_deny/hard_deny classifier) even in a fresh,
// unconfigured worktree - not "manual" as originally assumed when #3 was filed.
export const CLAUDE_PERMISSION_MODES = [
  { value: "", name: "Auto (CLI default)" },
  { value: "acceptEdits", name: "Accept edits" },
  { value: "manual", name: "Manual" },
  { value: "dontAsk", name: "Don't ask" },
  { value: "plan", name: "Plan mode" },
];

// Text/code mimes get sent as an Anthropic "document" block with a plain-text
// source rather than base64 - decoding to UTF-8 text lets the model read the
// content directly instead of round-tripping through a PDF-style opaque blob,
// and matches how Claude.ai treats a dropped .txt/.py/.md file.
function isTextMime(mime) {
  return mime.startsWith("text/") || /json|xml|yaml|javascript|typescript/.test(mime);
}

function toContentBlock(a) {
  if (a.mime.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: a.mime, data: a.base64 } };
  }
  if (isTextMime(a.mime)) {
    return {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: Buffer.from(a.base64, "base64").toString("utf8") },
      title: a.filename,
    };
  }
  // application/pdf and anything else unrecognized - treat as a base64 document,
  // matching the Anthropic Messages API's own default document handling.
  return { type: "document", source: { type: "base64", media_type: a.mime, data: a.base64 }, title: a.filename };
}

export class ClaudeCodeSession {
  /**
   * @param {boolean} resume - true when reconnecting to a persona that
   *   already existed before a server restart: uses --resume so claude-code's
   *   own on-disk session history is picked back up, instead of --session-id
   *   which would start a brand-new (empty) session under that id.
   * @param {string|null} [permissionMode] - one of CLAUDE_PERMISSION_MODES'
   *   values, or null/"" to omit --permission-mode entirely and let the CLI
   *   resolve its own default.
   */
  constructor(sessionId, model, personaName, workspaceDir, resume = false, permissionMode = null) {
    this.sessionId = sessionId;
    this.model = model;
    this.alive = true;
    this.queue = []; // pending {resolve, reject} for sendMessage calls, one at a time
    this.crashError = null;

    // Settable by the caller (server/index.mjs) after construction - fires
    // for turn-lifecycle events that arrive on this same long-lived process
    // while `queue` is empty, i.e. NOT in response to a sendMessage() call
    // symposion itself made. This happens when the CLI's own background-task
    // machinery (an Agent-tool dispatch launched with run_in_background)
    // delivers its completion as an unprompted new turn - previously these
    // events were silently discarded (`pending?.onToolUpdate?.()` on
    // undefined `pending`), so a detached subagent had zero visibility once
    // the turn that launched it had already ended (symposion-I45).
    this.onBackgroundEvent = null;

    // Without this, `personaName` is purely a UI label - the model itself
    // has no idea it's supposed to identify as that name and will (correctly)
    // deny it if asked. This makes the identity real, not just a sidebar label.
    const identityPrompt = `Your name is ${personaName}. If asked your name or who you are, identify yourself as ${personaName}.`;

    const sessionArgs = resume ? ["--resume", sessionId] : ["--session-id", sessionId];
    const permissionArgs = permissionMode ? ["--permission-mode", permissionMode] : [];

    this.proc = spawn(CLAUDE_BIN, [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...sessionArgs,
      "--model", model,
      "--append-system-prompt", identityPrompt,
      ...permissionArgs,
    ], { cwd: workspaceDir, stdio: ["pipe", "pipe", "pipe"] });

    // Per-turn content-block-index -> type ("text" | "thinking" | ...), so we
    // only stream deltas for the actual visible reply, not reasoning - same
    // chat-only-view rule as everywhere else in this app.
    this.blockTypes = new Map();

    // Ordered text/tool_use/tool_result parts for the CURRENT turn, built
    // from the full (non-streaming) "assistant"/"user" events rather than
    // the stream_event deltas above - those events already carry complete
    // blocks (text, tool_use with name+input, tool_result with output),
    // simpler than reassembling one from delta fragments. This is what the
    // tool-call visibility toggle (symposion#4) renders; unrelated to the
    // live char-by-char streaming, which stays exactly as it was.
    this.currentParts = [];

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this._handleLine(line));

    this.proc.stderr.on("data", (d) => {
      console.error(`[claude:${sessionId}] stderr:`, d.toString());
    });

    // A spawn failure (bad binary path, permissions, etc.) emits 'error',
    // not 'exit' - without a listener here it's an UNCAUGHT exception that
    // crashes the entire symposion process, taking every other running
    // persona down with it (confirmed live 2026-07-15: one persona's ENOENT
    // killed the whole server). This mirrors 'exit' below, guarded by a
    // dedicated flag (not `this.alive`, which kill() already sets false
    // synchronously on a normal delete-mid-turn - reusing it here would
    // wrongly skip 'exit's queue-drain in that case) so double-firing (both
    // events can fire for the same underlying failure, depending on Node
    // version) doesn't double-reject an already-cleared queue.
    let terminalHandled = false;
    this.proc.on("error", (err) => {
      if (terminalHandled) return;
      terminalHandled = true;
      this.alive = false;
      this.crashError = `claude process failed to start: ${err.message}`;
      console.error(`[claude:${sessionId}] spawn error:`, err);
      for (const { reject } of this.queue) reject(new Error(this.crashError));
      this.queue = [];
    });

    this.proc.on("exit", (code, signal) => {
      if (terminalHandled) return;
      terminalHandled = true;
      this.alive = false;
      if (this.queue.length > 0) {
        this.crashError = `claude process exited (code=${code}, signal=${signal}) while a message was in flight`;
        for (const { reject } of this.queue) reject(new Error(this.crashError));
        this.queue = [];
      }
    });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // non-JSON line (shouldn't happen with stream-json, but don't crash on it)
    }

    if (evt.type === "stream_event") {
      const e = evt.event;
      if (e.type === "content_block_start") {
        this.blockTypes.set(e.index, e.content_block?.type);
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        if (this.blockTypes.get(e.index) === "text") {
          const pending = this.queue[0];
          if (pending?.onDelta) pending.onDelta(e.delta.text);
        }
      }
      return;
    }

    if (evt.type === "assistant") {
      const pending = this.queue[0];
      for (const block of evt.message?.content ?? []) {
        if (block.type === "text") {
          this.currentParts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const part = { type: "tool", name: block.name, input: block.input, toolUseId: block.id, output: null, isError: null };
          this.currentParts.push(part);
          pending?.onToolUpdate?.({ ...part, status: "running" });
        }
        // "thinking" blocks intentionally skipped - chat-only view.
      }
      // No sendMessage() call is waiting on this event - it's a
      // background-originated turn (see onBackgroundEvent doc comment).
      if (!pending) this.onBackgroundEvent?.({ status: "running", parts: this.currentParts });
      return;
    }

    if (evt.type === "user") {
      const pending = this.queue[0];
      for (const block of evt.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        // Search from the end - a toolUseId is unique per call, but scanning
        // backward finds the most recent (only) match faster in the common case.
        for (let i = this.currentParts.length - 1; i >= 0; i--) {
          const part = this.currentParts[i];
          if (part.type === "tool" && part.toolUseId === block.tool_use_id) {
            part.output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            part.isError = !!block.is_error;
            pending?.onToolUpdate?.({ ...part, status: part.isError ? "error" : "done" });
            break;
          }
        }
      }
      if (!pending) this.onBackgroundEvent?.({ status: "running", parts: this.currentParts });
      return;
    }

    if (evt.type === "result") {
      this.blockTypes.clear();
      const pending = this.queue.shift();
      if (pending) {
        pending.resolve({
          replyText: evt.result ?? "",
          permissionDenials: evt.permission_denials ?? [],
          isError: !!evt.is_error,
          stopReason: evt.stop_reason,
          parts: this.currentParts,
          // total_cost_usd is the pay-as-you-go-equivalent dollar value even
          // under flat-rate subscription billing (confirmed live, symposion
          // issue "track tokens and spend per agent") - genuinely useful as
          // a cost signal regardless of which billing model is active.
          costUsd: evt.total_cost_usd ?? 0,
          usage: evt.usage
            ? {
                inputTokens: evt.usage.input_tokens ?? 0,
                outputTokens: evt.usage.output_tokens ?? 0,
                cacheReadTokens: evt.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: evt.usage.cache_creation_input_tokens ?? 0,
              }
            : null,
        });
      } else {
        this.onBackgroundEvent?.({ status: "done", parts: this.currentParts });
      }
      this.currentParts = [];
    }
  }

  /**
   * @param {Array<{filename:string, mime:string, base64:string}>} [attachments]
   * @param {(chunk: string) => void} [onDelta] - called with each visible text chunk as it streams
   * @param {(part: object) => void} [onToolUpdate] - called with a tool part (status: "running"|"done"|"error")
   *   as it starts (tool_use) and again once its result lands (tool_result) - lets callers show live
   *   tool-call progress instead of a mid-turn blackout while the turn is still in flight.
   */
  sendMessage(text, attachments, onDelta, onToolUpdate) {
    if (!this.alive) {
      return Promise.reject(new Error(this.crashError || "claude process is not running"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, onDelta, onToolUpdate });
      // No attachments: keep the plain-string content shape exactly as
      // before (zero wire-format change for the common case). With
      // attachments, switch to an Anthropic content-block array - the same
      // shape _handleLine already parses on the way OUT for assistant turns
      // (evt.message.content as an array of {type, ...} blocks), so the
      // stdin protocol accepting it symmetrically on the way in is the
      // CLI's own message format, not a symposion invention.
      const content =
        (attachments?.length ?? 0) === 0
          ? text
          : [...(text ? [{ type: "text", text }] : []), ...attachments.map(toContentBlock)];
      const line = JSON.stringify({ type: "user", message: { role: "user", content } });
      this.proc.stdin.write(line + "\n");
    });
  }

  kill() {
    this.alive = false;
    this.proc.kill();
  }
}
