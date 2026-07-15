import { spawn } from "node:child_process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = path.join(__dirname, "..", "node_modules", ".bin", "opencode");

// A running `opencode serve` is permanently tied to the one directory it was
// launched in (confirmed via GET /project - one fixed "worktree" entry, no
// way to add/switch directories on a live server). So multi-repo support
// means one opencode serve process per target directory, spun up on demand
// and reused thereafter - the same pattern as ClaudeCodeSession, just for
// the API backend instead of the claude CLI.

let nextPort = 4198; // 4197 is the original manually-started instance

export class OpenCodeServerPool {
  constructor() {
    /** @type {Map<string, {port:number, client:object, proc:import('child_process').ChildProcess, ready:Promise<void>}>} */
    this.byDirectory = new Map();
  }

  getOrCreate(directory) {
    if (this.byDirectory.has(directory)) return this.byDirectory.get(directory);

    const port = nextPort++;
    const proc = spawn(
      OPENCODE_BIN,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
    );

    let resolveReady, rejectReady;
    // Fail loud and fast on a bind/spawn failure (e.g. stale process still
    // holding the port) instead of hanging forever with no error - a silent
    // infinite hang is worse than a swallow, since nothing even reports it.
    const readyTimeout = setTimeout(() => {
      this.byDirectory.delete(directory); // don't cache a dead-end entry - let the next call retry on a fresh port
      proc.kill();
      rejectReady(new Error(`opencode serve for ${directory} did not report ready within 10s (port ${port} may be in use)`));
    }, 10_000);
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {}); // this promise is always awaited by callers - suppress the unhandled-rejection warning here

    proc.stdout.on("data", (d) => {
      const line = d.toString();
      if (line.includes("listening on")) {
        clearTimeout(readyTimeout);
        resolveReady();
      }
    });
    proc.stderr.on("data", (d) => console.error(`[opencode-serve:${directory}]`, d.toString()));
    proc.on("exit", (code) => {
      console.error(`[opencode-serve:${directory}] exited (code=${code})`);
      clearTimeout(readyTimeout);
      rejectReady(new Error(`opencode serve for ${directory} exited (code=${code}) before becoming ready`));
      this.byDirectory.delete(directory);
    });

    const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
    const events = new EventEmitter();
    const entry = { port, client, proc, ready, events };
    this.byDirectory.set(directory, entry);

    // If ready rejects, this derived promise rejects too (no onRejected
    // passed to .then) - the failure is already surfaced to whoever awaited
    // entry.ready directly, so just swallow it here rather than crash the
    // whole process with an unhandled rejection.
    ready.then(() => this._pumpEvents(port, events)).catch(() => {});

    return entry;
  }

  // One shared SSE reader per pool entry (per directory), fanning out
  // parsed events to whoever's listening for a given sessionID - avoids
  // opening a new /event connection per persona sharing the same directory.
  async _pumpEvents(port, events) {
    const res = await fetch(`http://127.0.0.1:${port}/event`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // last (possibly partial) line stays in the buffer
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          events.emit("event", evt);
        } catch {
          // ignore malformed lines
        }
      }
    }
  }
}
