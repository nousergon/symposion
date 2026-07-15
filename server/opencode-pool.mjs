import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = path.join(__dirname, "..", "node_modules", ".bin", "opencode");
const DATA_DIR = path.join(__dirname, "..", "data");
const REGISTRY_FILE = path.join(DATA_DIR, "opencode-pool.json");

// A running `opencode serve` is permanently tied to the one directory it was
// launched in (confirmed via GET /path - "directory" is instance-scoped and
// realpath-resolved; GET /project/current is NOT instance-scoped, it reports
// some global "current project" shared across every opencode process on the
// machine - a dead end tried and ruled out while building this). So
// multi-repo support means one opencode serve process per target directory,
// spun up on demand and reused thereafter - the same pattern as
// ClaudeCodeSession, just for the API backend instead of the claude CLI.
//
// Spawned children are NOT killed when this Node process dies (no
// process-group wiring). Root cause of symposion#9: this pool's port
// allocator (`nextPort`, below) always restarted from 4198 on every process
// restart, with no memory of ports already in use by children that outlived
// the crash - so the FIRST spawn after any restart would frequently collide
// with a still-running orphan on that exact port (confirmed empirically:
// spawning two DIFFERENT directories on two DIFFERENT ports works fine
// concurrently - it's a plain port collision, not a one-instance-per-
// directory server-side lock as originally assumed). REGISTRY_FILE persists
// {directory -> {port, pid}} across restarts so (a) nextPort is seeded past
// every port we've ever handed out, never blindly reusing one, and (b)
// getOrCreate() can ADOPT a surviving child for a known directory (verified
// alive via the pid, then verified via GET /path that it's still actually
// serving that exact directory) instead of spawning a redundant second one.

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch (err) {
    console.error("[pool] failed to read opencode-pool.json, starting empty:", err);
    return {};
  }
}

function saveRegistry(registry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/** signal 0 is a pure existence probe - throws ESRCH if the pid is gone, does not actually signal the process. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const initialRegistry = loadRegistry();

// Seed past every port this pool has ever handed out so a fresh spawn after
// a restart never collides with a surviving orphan - the actual root cause
// of symposion#9. 4197 is the original manually-started instance.
let nextPort = Math.max(4198, ...Object.values(initialRegistry).map((r) => r.port + 1));

export class OpenCodeServerPool {
  constructor() {
    /** @type {Map<string, {port:number, client:object, proc:import('child_process').ChildProcess|null, ready:Promise<void>, events:EventEmitter}>} */
    this.byDirectory = new Map();
    this.registry = initialRegistry;
  }

  getOrCreate(directory) {
    if (this.byDirectory.has(directory)) return this.byDirectory.get(directory);

    const events = new EventEmitter();
    const entry = { port: null, client: null, proc: null, events, ready: null };
    entry.ready = this._connect(directory, entry);
    entry.ready.catch(() => {}); // this promise is always awaited by callers - suppress the unhandled-rejection warning here
    this.byDirectory.set(directory, entry);
    return entry;
  }

  async _connect(directory, entry) {
    const recorded = this.registry[directory];
    if (recorded && isProcessAlive(recorded.pid) && (await this._verifyServing(recorded.port, directory))) {
      console.log(`[pool] adopted existing opencode serve for ${directory} on port ${recorded.port} (pid ${recorded.pid})`);
      entry.port = recorded.port;
      entry.client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${recorded.port}` });
      entry.proc = null; // predates this pool instance - not ours to own or kill
      this._pumpEvents(recorded.port, entry.events).catch((err) => console.error(`[pool] event pump for adopted ${directory} died:`, err));
      return;
    }
    if (recorded) {
      // Stale entry (process gone, or the port now serves something else) - drop it and spawn fresh.
      delete this.registry[directory];
      saveRegistry(this.registry);
    }
    await this._spawn(directory, entry);
  }

  /**
   * Confirms the server on `port` is actually still serving `directory`, not
   * some unrelated process that happens to hold the port. GET /path's
   * "directory" field is scoped to this specific instance (unlike
   * /project/current, which reports a global "current project" shared
   * across every opencode process on the machine - ruled out empirically)
   * and comes back realpath-resolved, so `directory` is resolved on our side
   * too before comparing (macOS's /tmp -> /private/tmp is exactly the kind
   * of mismatch that would otherwise cause a false negative here).
   */
  async _verifyServing(port, directory) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/path`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const info = await res.json();
      return info.directory === fs.realpathSync(directory);
    } catch {
      return false;
    }
  }

  _spawn(directory, entry) {
    const port = nextPort++;
    const proc = spawn(
      OPENCODE_BIN,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
    );

    return new Promise((resolveReady, rejectReady) => {
      // Fail loud and fast on a bind/spawn failure (e.g. stale process still
      // holding the port) instead of hanging forever with no error - a silent
      // infinite hang is worse than a swallow, since nothing even reports it.
      const readyTimeout = setTimeout(() => {
        this.byDirectory.delete(directory); // don't cache a dead-end entry - let the next call retry on a fresh port
        proc.kill();
        rejectReady(new Error(`opencode serve for ${directory} did not report ready within 10s (port ${port} may be in use)`));
      }, 10_000);

      proc.stdout.on("data", (d) => {
        const line = d.toString();
        if (line.includes("listening on")) {
          clearTimeout(readyTimeout);
          entry.port = port;
          entry.client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
          entry.proc = proc;
          this.registry[directory] = { port, pid: proc.pid };
          saveRegistry(this.registry);
          this._pumpEvents(port, entry.events).catch((err) => console.error(`[pool] event pump for ${directory} died:`, err));
          resolveReady();
        }
      });
      proc.stderr.on("data", (d) => console.error(`[opencode-serve:${directory}]`, d.toString()));
      proc.on("exit", (code) => {
        console.error(`[opencode-serve:${directory}] exited (code=${code})`);
        clearTimeout(readyTimeout);
        this.byDirectory.delete(directory);
        if (this.registry[directory]?.pid === proc.pid) {
          delete this.registry[directory];
          saveRegistry(this.registry);
        }
        rejectReady(new Error(`opencode serve for ${directory} exited (code=${code}) before becoming ready`));
      });
    });
  }

  // The server exposes two API generations side by side (confirmed live via
  // /doc: /session/{id}/permissions/{id} + /question/{id}/reply alongside
  // /api/session/{id}/permission/... + /api/session/{id}/question/...).
  // They looked interchangeable from the OpenAPI spec alone, but are NOT -
  // verified empirically that a permission request created through this v1
  // client's session.promptAsync only exists in the v1 registry; replying to
  // it via the v2 (/api/...) endpoint 404s with PermissionNotFoundError even
  // called within milliseconds of the request being asked. Since session
  // lifecycle here goes through the v1 client exclusively, permission/
  // question handling MUST stay on v1 too. The v1 SDK only wraps the single
  // permission-reply method (postSessionIdPermissionsPermissionId) - it has
  // no question support and no list endpoint for either, so list/reply/
  // reject for questions, and list for permissions, are hand-rolled fetch
  // calls below against the plain (non-/api) v1 REST paths, matching the
  // pattern _pumpEvents already uses for /event.

  /** Pending permission requests across all sessions on this server - callers filter by sessionID. */
  async listPermissions(port) {
    const res = await fetch(`http://127.0.0.1:${port}/permission`);
    if (!res.ok) throw new Error(`GET /permission failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Pending question requests across all sessions on this server - callers filter by sessionID. */
  async listQuestions(port) {
    const res = await fetch(`http://127.0.0.1:${port}/question`);
    if (!res.ok) throw new Error(`GET /question failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async replyQuestion(port, requestID, answers) {
    const res = await fetch(`http://127.0.0.1:${port}/question/${requestID}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(`POST /question/${requestID}/reply failed: ${res.status} ${await res.text()}`);
  }

  async rejectQuestion(port, requestID) {
    const res = await fetch(`http://127.0.0.1:${port}/question/${requestID}/reject`, { method: "POST" });
    if (!res.ok) throw new Error(`POST /question/${requestID}/reject failed: ${res.status} ${await res.text()}`);
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
