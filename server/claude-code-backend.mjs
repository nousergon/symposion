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

export class ClaudeCodeSession {
  constructor(sessionId, model, personaName, workspaceDir) {
    this.sessionId = sessionId;
    this.model = model;
    this.alive = true;
    this.queue = []; // pending {resolve, reject} for sendMessage calls, one at a time
    this.crashError = null;

    // Without this, `personaName` is purely a UI label - the model itself
    // has no idea it's supposed to identify as that name and will (correctly)
    // deny it if asked. This makes the identity real, not just a sidebar label.
    const identityPrompt = `Your name is ${personaName}. If asked your name or who you are, identify yourself as ${personaName}.`;

    this.proc = spawn("claude", [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--session-id", sessionId,
      "--model", model,
      "--append-system-prompt", identityPrompt,
    ], { cwd: workspaceDir, stdio: ["pipe", "pipe", "pipe"] });

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
    if (evt.type === "result") {
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

  sendMessage(text) {
    if (!this.alive) {
      return Promise.reject(new Error(this.crashError || "claude process is not running"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      const line = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      this.proc.stdin.write(line + "\n");
    });
  }

  kill() {
    this.alive = false;
    this.proc.kill();
  }
}
