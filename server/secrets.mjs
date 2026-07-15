import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// Mirrors the fleet's established secret-resolution pattern (see krepis
// secrets.py, morning-signal aws.py): env-var override first (local dev,
// or an operator who already exported it), SSM SecureString second,
// cached per key for the process lifetime. Naming convention: /symposion/{KEY}.
const SSM_PREFIX = "/symposion/";
const client = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
const cache = new Map();

/**
 * Resolves a secret by name (e.g. "DEEPSEEK_API_KEY"): returns
 * process.env[name] if set, otherwise fetches /symposion/{name} from SSM
 * (decrypted, cached). Returns null - never throws - if neither source has
 * it, since callers treat a missing optional provider key as "skip this
 * provider", not a startup-fatal error.
 */
export async function resolveSecret(name) {
  if (process.env[name]) return process.env[name];
  if (cache.has(name)) return cache.get(name);

  try {
    const res = await client.send(new GetParameterCommand({ Name: `${SSM_PREFIX}${name}`, WithDecryption: true }));
    const value = res.Parameter?.Value ?? null;
    cache.set(name, value);
    return value;
  } catch (err) {
    if (err.name !== "ParameterNotFound") {
      console.error(`[secrets] SSM lookup for ${SSM_PREFIX}${name} failed:`, err.message);
    }
    cache.set(name, null);
    return null;
  }
}
