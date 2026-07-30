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
  { modelID: "claude-opus-5", name: "Opus 5" },
  { modelID: "claude-sonnet-5", name: "Sonnet 5" },
  { modelID: "claude-opus-4-8", name: "Opus 4.8" },
  { modelID: "claude-haiku-4-5", name: "Haiku 4.5" },
  { modelID: "claude-fable-5", name: "Fable 5" },
];

/**
 * Is `modelID` something `claude -p --model` will actually accept?
 *
 * This exists because the CLI does NOT fail fast on an unknown model. It
 * spawns fine, accepts the turn, and answers with an assistant message
 * reading "There's an issue with the selected model (X)" carrying a 404
 * `model_not_found` - i.e. the failure arrives as an ordinary-looking reply
 * inside the transcript, indistinguishable in the UI from the model
 * declining to help. Every claude-code persona created with a capability
 * CLASS as its model ("low"/"med"/"high"/"ultra" - see symposion-I96) failed
 * exactly this way, and the class name sat in `lastRecipe`, so every
 * subsequent claude-code agent inherited it.
 *
 * The claude-code backend is P1's bounded exception: it shells out to a CLI
 * that takes a concrete model ID and has no concept of a capability class,
 * so CLAUDE_MODELS is the whole vocabulary. Anything else is a bug in the
 * caller, checked at the one chokepoint every spawn path goes through.
 */
export function isValidClaudeModel(modelID) {
  return CLAUDE_MODELS.some((m) => m.modelID === modelID);
}

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

// The claude CLI's own --effort choices (verified via `claude --help`).
// null/omitted means "let the CLI pick its own default" rather than
// symposion hardcoding an assumption about what that default is - same
// null-means-CLI-default convention as CLAUDE_PERMISSION_MODES above.
export const CLAUDE_EFFORT_LEVELS = [
  { value: "", name: "Auto (CLI default)" },
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "XHigh" },
  { value: "max", name: "Max" },
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

// Two guards, because "how long has this turn been running" and "how long
// has this process been silent" answer different questions, and only the
// second one distinguishes a hung process from a working one.
//
// The single wall-clock cap these replace killed HEALTHY turns. Observed
// live 2026-07-30: a research turn that had streamed 31 tool calls and was
// still emitting events was killed at the 10-minute mark and reported to
// the user as "process killed" — a guard whose whole purpose is to tell a
// stalled persona from a thinking one, firing on a thinking one. An
// elapsed-time predicate cannot make that distinction at all, which is why
// symposion-policy.md T0-2 states the requirement as "no output for a
// bounded interval", not "running for a bounded interval".
//
// IDLE is the real liveness predicate. A `claude -p --output-format
// stream-json` process emits an event for every text delta, tool_use and
// tool_result, so a hang looks like SILENCE, not like duration. 15 minutes
// clears the longest legitimate gap between two events — a Bash call at the
// CLI's own 600s ceiling, or a synchronous Agent dispatch, both of which
// emit nothing at all between their tool_use and their tool_result — with
// margin. The clock it reads (`lastEventAt`) is stamped in _handleLine on
// every event the process produces, whatever type it is.
//
// HARD never resets. It exists only to bound a pathological tool loop that
// keeps emitting events forever and so would never trip the idle guard —
// the same job, and the same reasoning, as the OpenCode path's own hard
// timer in server/index.mjs. It is deliberately far above any real turn: it
// is a runaway backstop, not an opinion about how long work may take.
export const TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const TURN_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export class ClaudeCodeSession {
  /**
   * @param {boolean} resume - true when reconnecting to a persona that
   *   already existed before a server restart: uses --resume so claude-code's
   *   own on-disk session history is picked back up, instead of --session-id
   *   which would start a brand-new (empty) session under that id.
   * @param {string|null} [permissionMode] - one of CLAUDE_PERMISSION_MODES'
   *   values, or null/"" to omit --permission-mode entirely and let the CLI
   *   resolve its own default.
   * @param {string|null} [effortLevel] - one of CLAUDE_EFFORT_LEVELS' values,
   *   or null/"" to omit --effort entirely and let the CLI resolve its own
   *   default.
   * @param {{spawnFn?: Function}} [opts] - `spawnFn` overrides child_process
   *   .spawn. Test seam only, and a deliberately narrow one: the turn guards
   *   and the stdin/exit crash paths are only meaningfully testable against a
   *   process whose output and death this side controls, and the alternative
   *   (asserting on a hand-built object grafted onto the prototype) tests a
   *   stand-in rather than the wiring the constructor actually performs -
   *   which is exactly where these defects lived. No production caller passes
   *   it, so the real spawn stays the only path in the running service.
   */
  constructor(sessionId, model, personaName, workspaceDir, resume = false, permissionMode = null, effortLevel = null, opts = {}) {
    // RAISE rather than spawn a process that will answer every turn with a
    // 404 dressed as an assistant message - see isValidClaudeModel(). This is
    // the single chokepoint for every spawn path (create, model switch,
    // quick-agent, reconnect-after-restart), so no caller can route around it.
    if (!isValidClaudeModel(model)) {
      throw new Error(`unusable claude-code model: ${JSON.stringify(model)}. Valid: ${CLAUDE_MODELS.map((m) => m.modelID).join(", ")}`);
    }
    this.sessionId = sessionId;
    this.model = model;
    this.alive = true;
    this.queue = []; // pending {resolve, reject} for sendMessage calls, one at a time
    this.crashError = null;

    // Epoch ms of the last event this process produced, or null when no turn
    // is in flight. This is the liveness clock the idle guard reads, and the
    // same clock `idleMs` exposes to the UI so a persona that has gone quiet
    // renders as quiet rather than as indistinguishably "Working…"
    // (symposion-policy.md T0-2, P4).
    this.lastEventAt = null;

    // { at: epochMs, reason } when this persona's last completed turn ended
    // with a live ScheduleWakeup call (/loop dynamic-mode); null otherwise.
    // Set/cleared in _updateScheduledWakeup(), called from the "result"
    // handler below - see that method's doc comment.
    this.scheduledWakeup = null;

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
    const effortArgs = effortLevel ? ["--effort", effortLevel] : [];

    const spawnFn = opts.spawnFn ?? spawn;
    this.proc = spawnFn(CLAUDE_BIN, [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...sessionArgs,
      "--model", model,
      "--append-system-prompt", identityPrompt,
      ...permissionArgs,
      ...effortArgs,
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
      this._drainQueue(this.crashError);
    });

    this.proc.on("exit", (code, signal) => {
      if (terminalHandled) return;
      terminalHandled = true;
      this.alive = false;
      if (this.queue.length > 0) {
        this.crashError = `claude process exited (code=${code}, signal=${signal}) while a message was in flight`;
        this._drainQueue(this.crashError);
      }
    });

    // Writing to a dead child's stdin emits 'error' on the STREAM, and with
    // no listener that is an uncaught exception which takes the entire
    // symposion process down — every other persona's in-flight turn with it.
    // Confirmed live: `Error: write EPIPE` killed the server outright after
    // the CLI exited on "No conversation found with session ID", and launchd
    // restarted into a console where every running turn had silently
    // vanished. This is the SAME defect shape the proc.on("error") handler
    // above documents; the fix was applied to the spawn path in that pass and
    // never to the write path, so the class survived its own fix.
    //
    // The 'exit' handler cannot cover this: it fires asynchronously, so a
    // write issued in the window between the child dying and Node delivering
    // 'exit' still lands on a closed pipe with `this.alive` still true.
    this.proc.stdin.on("error", (err) => {
      this.alive = false;
      console.error(`[claude:${sessionId}] stdin error:`, err.message);
      this.crashError ??= `claude process stdin closed (${err.code ?? err.message}) — the CLI exited underneath a write`;
      this._drainQueue(this.crashError);
    });
  }

  /**
   * Reject every queued turn with `message` and clear its guard timers.
   * Every terminal path (spawn error, exit, stdin EPIPE) ends here so none
   * of them can leave a live timer pointing at an already-settled promise.
   */
  _drainQueue(message) {
    for (const entry of this.queue.splice(0)) {
      clearTimeout(entry.idleTimer);
      clearTimeout(entry.hardTimer);
      entry.reject(new Error(message));
    }
    this.lastEventAt = null;
  }

  /**
   * How long this process has produced NO output, in ms — null when no turn
   * is in flight. Read by the UI (via personaSummary) so silence is visible
   * as silence long before the idle guard acts on it: a persona that has
   * been quiet for six minutes and one that is streaming tokens rendered
   * identically before this, which is the exact confusion T0-2 names.
   */
  get idleMs() {
    return this.lastEventAt === null ? null : Date.now() - this.lastEventAt;
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // non-JSON line (shouldn't happen with stream-json, but don't crash on it)
    }

    // Any parseable event is proof of life, whatever kind it is — that is
    // the whole point of an idle predicate over an elapsed-time one. Set
    // before the per-type branches below so a type this method doesn't
    // otherwise handle still counts as the process being alive.
    if (this.queue.length > 0) this.lastEventAt = Date.now();

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
      if (this.queue.length === 0) this.lastEventAt = null;
      if (pending) {
        clearTimeout(pending.idleTimer);
        clearTimeout(pending.hardTimer);
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
      this._updateScheduledWakeup();
      this.currentParts = [];
    }
  }

  /**
   * A persona has a pending wakeup iff the turn that JUST finished ended
   * with a live (non-stop) ScheduleWakeup call - previously invisible in
   * symposion's UI once that turn ended, since it was just another tool
   * call buried in the (collapsed) tool-parts history, with nothing
   * distinguishing "idle, nothing pending" from "idle, but about to resume
   * on its own in 4 minutes". Any other turn ending - including one that
   * calls ScheduleWakeup with stop:true, or one that doesn't call it at
   * all - clears it, so a fired wakeup (which starts a new turn) or an
   * explicit loop-stop both correctly drop the indicator.
   */
  _updateScheduledWakeup() {
    const call = [...this.currentParts].reverse().find((p) => p.type === "tool" && p.name === "ScheduleWakeup");
    const delaySeconds = Number(call?.input?.delaySeconds);
    this.scheduledWakeup =
      call && call.input?.stop !== true && Number.isFinite(delaySeconds) && delaySeconds > 0
        ? { at: Date.now() + delaySeconds * 1000, reason: call.input?.reason ?? null }
        : null;
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
      const entry = { resolve, reject, onDelta, onToolUpdate, idleTimer: null, hardTimer: null };

      // Both guards end the turn the same way: the process is killed, so the
      // next reconnect starts fresh rather than resuming a poisoned session.
      const failTurn = (message) => {
        const idx = this.queue.indexOf(entry);
        if (idx < 0) return; // already settled by a result/exit/stdin path
        this.queue.splice(idx, 1);
        clearTimeout(entry.idleTimer);
        clearTimeout(entry.hardTimer);
        // Killed unconditionally, not only when this entry was at the head.
        // The idle predicate is a property of the PROCESS (nothing at all
        // has been emitted), so a queued turn observing it is observing the
        // same hang the head turn is; and a head turn that has run past the
        // hard cap is not a process a queued turn should be handed to.
        this.alive = false;
        this.crashError = message;
        this.proc.kill();
        reject(new Error(message));
      };

      // Idle guard. Re-arms rather than being reset per event: a turn emits
      // one event per streamed token, and clearTimeout/setTimeout on every
      // one of those is thousands of timer churns per turn for no benefit.
      // Instead it wakes at the deadline, re-reads the liveness clock, and
      // only fails when the process has GENUINELY been silent that long.
      const checkIdle = () => {
        const idleFor = this.lastEventAt === null ? 0 : Date.now() - this.lastEventAt;
        if (idleFor < TURN_IDLE_TIMEOUT_MS) {
          entry.idleTimer = setTimeout(checkIdle, TURN_IDLE_TIMEOUT_MS - idleFor);
          return;
        }
        failTurn(
          `claude process produced no output for ${TURN_IDLE_TIMEOUT_MS / 60000} minutes — process killed`,
        );
      };
      entry.idleTimer = setTimeout(checkIdle, TURN_IDLE_TIMEOUT_MS);

      entry.hardTimer = setTimeout(() => {
        failTurn(
          `claude turn exceeded the ${TURN_HARD_TIMEOUT_MS / 3600000}-hour hard limit while still emitting events — process killed`,
        );
      }, TURN_HARD_TIMEOUT_MS);

      this.queue.push(entry);
      // Start the liveness clock at enqueue: until the process emits its
      // first event there is nothing else to measure silence from, and a
      // process that never answers at all must still trip the idle guard.
      this.lastEventAt ??= Date.now();
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
      // `this.alive` is not sufficient on its own: it is cleared by the
      // 'exit' handler, which fires asynchronously, so a child that has
      // already gone still reads as alive here. Checking the stream itself
      // closes that window; the stdin 'error' listener in the constructor
      // catches what remains (the child dying mid-write).
      if (!this.proc.stdin.writable) {
        failTurn("claude process stdin is closed — the CLI is no longer running");
        return;
      }
      this.proc.stdin.write(line + "\n");
    });
  }

  kill() {
    this.alive = false;
    this.lastEventAt = null;
    this.proc.kill();
  }
}
