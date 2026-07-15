import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mirrors ~/Development/claude_to_deepseek_api.sh's proxy-management pattern
// exactly (spawn-if-not-running via a health check, never auto-kill - a
// persistent local daemon outlives any one symposion restart, costs nothing
// idle, and two concurrent processes reusing it would otherwise race an
// exit-trap kill). Routes symposion's OpenCode-backed personas' real-
// DeepSeek traffic through the same content-scanning egress proxy the
// Claude-Code-routed sessions already use (deepseek_egress_proxy.py), just
// with --upstream-prefix "" for DeepSeek's OpenAI-compatible endpoint
// instead of "/anthropic" - see that file's module docstring. Deliberately
// NOT reusing port 8971 (the Anthropic-wire instance) since the two speak
// different upstream wire formats.
//
// OpenCode's own "deepseek" provider config (~/.config/opencode/opencode.jsonc,
// machine-local) points baseURL at this proxy with a placeholder apiKey -
// OpenCode's own process never sees the real DEEPSEEK_API_KEY at all; only
// this proxy process does, matching the same defense-in-depth property the
// Claude-Code-routed path already has.
const PROXY_PORT = 8972;
const ROUTING_DIR = path.join(os.homedir(), "Development", ".llm-routing");
const PROXY_SCRIPT = path.join(ROUTING_DIR, "deepseek_egress_proxy.py");
const LOG_PATH = path.join(ROUTING_DIR, "deepseek-egress-proxy-openai.log");

async function isHealthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/__proxy_health__`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensures the OpenAI-wire DeepSeek egress proxy is running on PROXY_PORT,
 * spawning it if not (never killing an existing instance - see module doc).
 * Returns true once healthy, false if it never came up within the timeout
 * (caller should treat this as "real DeepSeek unavailable this session",
 * not startup-fatal - the free opencode-zen proxy still works).
 */
export async function ensureDeepseekProxy(deepseekKey) {
  if (await isHealthy()) {
    console.log(`[deepseek-proxy] already running on :${PROXY_PORT} - reusing it`);
    return true;
  }

  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  const proc = spawn(
    "python3",
    [PROXY_SCRIPT, "--port", String(PROXY_PORT), "--upstream-prefix", ""],
    { env: { ...process.env, DEEPSEEK_API_KEY: deepseekKey }, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);
  proc.unref(); // outlives this symposion process on purpose, matching claude_to_deepseek_api.sh's disown

  for (let i = 0; i < 30; i++) {
    if (await isHealthy()) {
      console.log(`[deepseek-proxy] started on :${PROXY_PORT}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`[deepseek-proxy] failed to become healthy within 6s - real DeepSeek account will not be available this session`);
  return false;
}
