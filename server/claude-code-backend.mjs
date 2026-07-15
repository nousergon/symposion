import { spawn } from "node:child_process";
import readline from "node:readline";

// Persistent claude -p subprocess per persona, keyed off the empirical
// findings from the symposion spikes:
//  - stream-json in/out survives multiple turns on one live process
//    (no --resume / respawn needed between messages)
//  - there is NO live permission pause in headless mode - a blocked action
//    shows up as a non-empty `permission_denials` array on the turn's
//    `result` event, after the fact, not as a mid-turn prompt
//  - --output-format stream-json requires --verbose alongside --print

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

    // Without this, `personaName` is purely a UI label - the model itself
    // has no idea it's supposed to identify as that name and will (correctly)
    // deny it if asked. This makes the identity real, not just a sidebar label.
    const identityPrompt = `Your name is ${personaName}. If asked your name or who you are, identify yourself as ${personaName}.`;

    const sessionArgs = resume ? ["--resume", sessionId] : ["--session-id", sessionId];
    const permissionArgs = permissionMode ? ["--permission-mode", permissionMode] : [];

    this.proc = spawn("claude", [
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

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this._handleLine(line));

    this.proc.stderr.on("data", (d) => {
      console.error(`[claude:${sessionId}] stderr:`, d.toString());
    });

    this.proc.on("exit", (code, signal) => {
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

    if (evt.type === "result") {
      this.blockTypes.clear();
      const pending = this.queue.shift();
      if (pending) {
        pending.resolve({
          replyText: evt.result ?? "",
          permissionDenials: evt.permission_denials ?? [],
          isError: !!evt.is_error,
          stopReason: evt.stop_reason,
        });
      }
    }
  }

  /** @param {(chunk: string) => void} [onDelta] - called with each visible text chunk as it streams */
  sendMessage(text, onDelta) {
    if (!this.alive) {
      return Promise.reject(new Error(this.crashError || "claude process is not running"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, onDelta });
      const line = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      this.proc.stdin.write(line + "\n");
    });
  }

  kill() {
    this.alive = false;
    this.proc.kill();
  }
}
