import { spawn } from "node:child_process";
import path from "node:path";
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

    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    proc.stdout.on("data", (d) => {
      const line = d.toString();
      if (line.includes("listening on")) resolveReady();
    });
    proc.stderr.on("data", (d) => console.error(`[opencode-serve:${directory}]`, d.toString()));
    proc.on("exit", (code) => {
      console.error(`[opencode-serve:${directory}] exited (code=${code})`);
      this.byDirectory.delete(directory);
    });

    const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
    const entry = { port, client, proc, ready };
    this.byDirectory.set(directory, entry);
    return entry;
  }
}
