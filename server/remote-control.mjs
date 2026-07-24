import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hand a claude-code persona's session off to Anthropic's Remote Control so
// it can be continued from the official Claude mobile/web apps, then reclaim
// it later - full conversation continuity in both directions.
//
// Empirical findings this module is built on (verified live 2026-07-17):
//  - `claude remote-control --session-id <id>` (the SUBCOMMAND) looks the id
//    up in Anthropic's server-side registry of remote-control sessions and
//    CANNOT see sessions created via -p/--print - it errors with "Could not
//    reach the server to look up session". Useless for symposion's personas.
//  - `claude --resume <id> --remote-control` (the FLAG form) resumes from the
//    LOCAL on-disk transcript first - full prior context, including turns
//    produced by symposion's own -p subprocess - and then registers the live
//    session for Remote Control, printing a per-launch
//    https://claude.ai/code/session_... URL.
//  - The flag form only works under a real pty: with plain-pipe stdio it
//    errors out before ever reaching the interactive UI ("No deferred tool
//    marker found..." / "Provide a prompt to continue"). /usr/bin/script
//    provides the pty without needing a native node-pty dependency (macOS-only
//    is fine - symposion already depends on launchd/macOS in infra/).
//  - Interactive mode (unlike -p, which skips it) enforces the per-directory
//    "workspace trust" gate, recorded as projects[<dir>].hasTrustDialogAccepted
//    in ~/.claude.json - there is no CLI flag or subcommand to accept it
//    non-interactively, so ensureWorkspaceTrusted() below writes the flag
//    directly. Deliberate tradeoff (Brian's call, 2026-07-17): this touches an
//    undocumented internal CLI state file whose shape could change in a future
//    claude release - the alternative (driving the real trust prompt through
//    the pty) was judged not worth the extra machinery for a personal tool
//    whose worktrees are all self-created and genuinely trusted.

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// CodeQL js/prototype-polluting-assignment: config.projects is a plain
// object keyed by directory path, and bracket-assigning a key literally
// equal to "__proto__" mutates Object.prototype instead of adding an own
// property. dir is validated upstream (absolute + existing dir, index.mjs
// POST /api/personas) so this can't be reached in practice today, but the
// guard is one line and makes this safe independent of that.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertSafeKey(key) {
  if (UNSAFE_KEYS.has(key)) throw new Error(`Refusing unsafe key: ${key}`);
  return key;
}

/**
 * The claude CLI's mapping from a session cwd to its transcript directory
 * name under ~/.claude/projects: every non-alphanumeric character becomes a
 * dash. Verified against real entries (e.g. /Users/.../Development/
 * .symposion-worktrees/symposion__foo-123 is stored as
 * -Users-...-Development--symposion-worktrees-symposion--foo-123 - both the
 * leading dot and the double underscore munge to dashes, not just slashes).
 */
function mungeCwdForProjectsDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(cwd, sessionId) {
  return path.join(CLAUDE_PROJECTS_DIR, mungeCwdForProjectsDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Marks `dir` as trusted in ~/.claude.json (projects[dir].hasTrustDialogAccepted),
 * mirroring exactly what clicking through the CLI's own trust dialog records -
 * required because the Remote Control handoff launches claude in interactive
 * mode, which (unlike the -p mode symposion normally uses) refuses to start in
 * an untrusted directory, and offers no non-interactive way to accept.
 * Merge-preserving and atomic: existing per-project fields (allowedTools,
 * MCP config, usage stats) are kept intact, and the write goes through a
 * temp-file rename so a crash mid-write can't truncate the CLI's config.
 */
export function ensureWorkspaceTrusted(dir) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
  } catch (err) {
    // A missing/corrupt ~/.claude.json means the claude CLI itself has never
    // run (or is broken) - starting remote-control would fail anyway, and
    // fabricating a fresh config wholesale risks clobbering CLI state we
    // don't understand. Fail loud instead.
    throw new Error(`cannot read ${CLAUDE_CONFIG_PATH} to record workspace trust: ${err.message}`);
  }
  config.projects ??= {};
  const entry = config.projects[dir] ?? {};
  if (entry.hasTrustDialogAccepted === true) return;
  entry.hasTrustDialogAccepted = true;
  config.projects[assertSafeKey(dir)] = entry;
  const tmpPath = `${CLAUDE_CONFIG_PATH}.symposion-tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, CLAUDE_CONFIG_PATH);
}

// Matches both observed Remote Control URL shapes: the per-session
// .../code/session_... printed by `--resume ... --remote-control`, and the
// .../code?environment=... printed by the `claude remote-control` server mode.
const RC_URL_RE = /https:\/\/claude\.ai\/code(?:\/session_[A-Za-z0-9_]+|\?environment=[A-Za-z0-9_]+)/;

// CSI sequences (colors, cursor movement) and OSC sequences (terminal title) -
// the interactive UI interleaves these heavily; stripping them from the
// accumulated buffer is what makes the URL regex see contiguous text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Spawns `claude --resume <sessionId> --remote-control` under a pty (via
 * /usr/bin/script) in `cwd` and resolves with { pid, url } once the
 * Remote Control URL appears in its output. The process keeps running after
 * resolution - it IS the live session the phone talks to - and is spawned
 * detached (own process group) so stopRemoteControl() can kill the whole
 * script+claude pair, and so it survives a symposion server restart (the
 * remote session stays usable from the phone even if symposion dies).
 */
export function startRemoteControl({ claudeBin, sessionId, cwd, model, personaName, permissionMode }) {
  const args = [
    "-q", "/dev/null",
    claudeBin,
    "--resume", sessionId,
    "--model", model,
    "--append-system-prompt", `Your name is ${personaName}. If asked your name or who you are, identify yourself as ${personaName}.`,
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
    // Last, and with the persona's name as its optional value, so the session
    // shows up in claude.ai/code under a recognizable name.
    "--remote-control", personaName,
  ];

  const proc = spawn("/usr/bin/script", args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // launchd's minimal environment may not carry TERM; the interactive UI
    // needs one to render (and thus to print the URL we're waiting for).
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
  });

  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error(`remote-control did not produce a connection URL within 45s; output so far: ${cleanTail()}`));
    }, 45_000);

    function cleanTail() {
      return buf.replace(ANSI_RE, "").replace(/\s+/g, " ").trim().slice(-500);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
      reject(err);
    }

    function onData(chunk) {
      buf += chunk.toString();
      const cleaned = buf.replace(ANSI_RE, "");
      const match = cleaned.match(RC_URL_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        // Stop buffering UI repaints forever - the process stays alive but we
        // no longer need its output once the URL is captured.
        proc.stdout.removeListener("data", onData);
        proc.stderr.removeListener("data", onData);
        resolve({ pid: proc.pid, url: match[0] });
        return;
      }
      const errMatch = cleaned.match(/Error: [^\r\n]+/);
      if (errMatch) fail(new Error(errMatch[0]));
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => fail(new Error(`failed to spawn remote-control: ${err.message}`)));
    proc.on("exit", (code, signal) => {
      if (!settled) fail(new Error(`remote-control exited before producing a URL (code=${code}, signal=${signal}): ${cleanTail()}`));
    });
  });
}

/**
 * Kills the handoff's whole process group (script + claude). Best-effort by
 * design: the pid may already be dead (phone session ended, machine slept,
 * symposion restarted long after), and reclaim must still succeed in that
 * case - the caller's job is to get the persona back, not to insist on a
 * clean kill of something already gone.
 */
export function stopRemoteControl(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Group already gone (or pid recycled into a non-group-leader) - try the
    // bare pid as a fallback, then give up quietly; see doc comment.
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone - fine */ }
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the turns appended to the persona's on-disk claude transcript after
 * `sinceTs` (the handoff start) and reshapes them into symposion's own
 * message format - this is what makes remote turns show up in the symposion
 * chat after a reclaim instead of silently vanishing from its history.
 *
 * Transcript facts this parser relies on (same stream-json shapes
 * claude-code-backend.mjs already parses off stdout, plus the on-disk
 * extras): each line is one JSON event with type/timestamp; user lines carry
 * either real user input or tool_result continuations; assistant lines carry
 * text and tool_use blocks; sidechain (subagent-internal) lines are marked
 * isSidechain and meta lines isMeta - both skipped, matching the live view's
 * chat-only rule.
 */
export function importRemoteTurns(cwd, sessionId, sinceTs) {
  const file = transcriptPath(cwd, sessionId);
  if (!fs.existsSync(file)) {
    throw new Error(`transcript not found at ${file} - cannot import remote turns`);
  }

  const messages = [];
  let currentAssistant = null;

  function flushAssistant() {
    if (currentAssistant && (currentAssistant.text || currentAssistant.parts.length > 0)) {
      messages.push({
        role: "assistant",
        text: currentAssistant.text || "(no text response)",
        ts: currentAssistant.ts,
        parts: currentAssistant.parts,
        viaRemote: true,
      });
    }
    currentAssistant = null;
  }

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // torn final line from a live writer - not an error
    }
    if (evt.type !== "user" && evt.type !== "assistant") continue;
    if (evt.isSidechain || evt.isMeta) continue;
    const ts = Date.parse(evt.timestamp);
    if (!Number.isFinite(ts) || ts <= sinceTs) continue;

    const content = evt.message?.content;

    if (evt.type === "assistant") {
      currentAssistant ??= { text: "", parts: [], ts };
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "text") {
          currentAssistant.text += block.text;
          currentAssistant.parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          currentAssistant.parts.push({ type: "tool", name: block.name, input: block.input, toolUseId: block.id, output: null, isError: null });
        }
        // thinking blocks intentionally skipped - chat-only view.
      }
      continue;
    }

    // type === "user": either a tool_result continuation of the assistant
    // turn in progress, or real human input (which closes that turn).
    if (Array.isArray(content) && content.every((b) => b.type === "tool_result")) {
      for (const block of content) {
        const part = currentAssistant?.parts.findLast((p) => p.type === "tool" && p.toolUseId === block.tool_use_id);
        if (part) {
          part.output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          part.isError = !!block.is_error;
        }
      }
      continue;
    }

    const text = typeof content === "string"
      ? content
      : (Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("") : "");
    if (!text) continue;
    flushAssistant();
    messages.push({ role: "user", text, ts, viaRemote: true });
  }

  flushAssistant();
  return messages;
}
