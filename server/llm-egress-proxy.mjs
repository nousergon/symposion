import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mirrors ~/Development/claude_to_deepseek_api.sh's proxy-management pattern
// exactly (spawn-if-not-running via a health check, never auto-kill - a
// persistent local daemon outlives any one symposion restart, costs nothing
// idle, and two concurrent processes reusing it would otherwise race an
// exit-trap kill). Routes every OpenCode-backed persona's real direct-API
// traffic through the same content-scanning egress proxy the Claude-Code-
// routed sessions already use (llm_egress_proxy.py, formerly DeepSeek-only
// - generalized 2026-07-19 so xAI and any future direct-API provider reuse
// the same script instead of forking it per provider) - see that file's
// module docstring. Each provider gets its own instance (distinct port),
// since they speak to different upstream hosts.
//
// OpenCode's own provider config (~/.config/opencode/opencode.jsonc,
// machine-local) points each provider's baseURL at its proxy instance with
// a placeholder apiKey - OpenCode's own process never sees the real API key
// at all; only the corresponding proxy process does, matching the same
// defense-in-depth property the Claude-Code-routed path already has.
const ROUTING_DIR = path.join(os.homedir(), "Development", ".llm-routing");
const PROXY_SCRIPT = path.join(ROUTING_DIR, "llm_egress_proxy.py");
// config-I3007 dev-security 1/5: prefer the frozen standalone binary so every
// egress-proxy instance runs with its own process identity (distinct from the
// shared python interpreter), which is what makes a LuLu per-process firewall
// rule meaningful. Falls back to `python3 PROXY_SCRIPT` when the binary hasn't
// been built on this machine (.llm-routing/bin/build-egress-proxy.sh).
const EGRESS_BIN = path.join(ROUTING_DIR, "bin", "llm-egress-proxy");
function resolveProxyLaunch() {
  try {
    fs.accessSync(EGRESS_BIN, fs.constants.X_OK);
    return { cmd: EGRESS_BIN, baseArgs: [] };
  } catch {
    return { cmd: "python3", baseArgs: [PROXY_SCRIPT] };
  }
}

async function isHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__proxy_health__`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensures a provider's egress proxy is running on its assigned port,
 * spawning it if not (never killing an existing instance - see module
 * doc). Returns true once healthy, false if it never came up within the
 * timeout (caller should treat this as "real <provider> unavailable this
 * session", not startup-fatal - the free opencode-zen proxy still works
 * for personas that fall back to it).
 *
 * @param {{providerId: string, port: number, upstreamHost: string, apiKeyEnv: string, apiKey: string, upstreamPrefix?: string}} opts
 */
export async function ensureEgressProxy({ providerId, port, upstreamHost, apiKeyEnv, apiKey, upstreamPrefix = "" }) {
  if (await isHealthy(port)) {
    console.log(`[${providerId}-proxy] already running on :${port} - reusing it`);
    return true;
  }

  const logPath = path.join(ROUTING_DIR, `symposion-${providerId}-egress-proxy.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const { cmd, baseArgs } = resolveProxyLaunch();
  const proc = spawn(
    cmd,
    [
      ...baseArgs,
      "--port", String(port),
      "--upstream-host", upstreamHost,
      "--api-key-env", apiKeyEnv,
      "--upstream-prefix", upstreamPrefix,
    ],
    { env: { ...process.env, [apiKeyEnv]: apiKey }, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);
  proc.unref(); // outlives this symposion process on purpose, matching claude_to_deepseek_api.sh's disown

  for (let i = 0; i < 30; i++) {
    if (await isHealthy(port)) {
      console.log(`[${providerId}-proxy] started on :${port}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`[${providerId}-proxy] failed to become healthy within 6s - real ${providerId} account will not be available this session`);
  return false;
}
