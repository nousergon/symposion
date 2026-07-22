import webPush from "web-push";
import { resolveSecret } from "./secrets.mjs";

// symposion's own independent VAPID identity (/symposion/WEBPUSH_VAPID_*),
// deliberately separate from any Python-fleet identity (krepis.webpush
// resolves its own shared keypair at /alpha-engine/WEBPUSH_VAPID_*) -
// a browser PushSubscription is inherently scoped to the origin/service-
// worker that created it, so there's no cross-runtime benefit to sharing
// one keypair, and keeping them independent means a compromised Python
// consumer can't forge pushes to symposion's subscribers or vice versa.
const VAPID_SUBJECT = "mailto:ops@nousergon.com";

let vapidConfigured = null; // null = not yet attempted, false = attempted+unavailable

async function ensureConfigured() {
  if (vapidConfigured !== null) return vapidConfigured;
  const [publicKey, privateKey] = await Promise.all([
    resolveSecret("WEBPUSH_VAPID_PUBLIC_KEY"),
    resolveSecret("WEBPUSH_VAPID_PRIVATE_KEY"),
  ]);
  if (!publicKey || !privateKey) {
    console.error("[webpush] WEBPUSH_VAPID_PUBLIC_KEY/PRIVATE_KEY not configured - push disabled");
    vapidConfigured = false;
    return false;
  }
  webPush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export async function getVapidPublicKey() {
  return resolveSecret("WEBPUSH_VAPID_PUBLIC_KEY");
}

/**
 * Sends one Web Push notification. Never throws - a failed push must never
 * block the caller's turn-completion path (same fire-and-forget contract as
 * krepis.telegram.send_message / krepis.webpush.send_push).
 *
 * @returns {{ok: boolean, expired?: boolean}} `expired: true` on a 404/410
 *   from the push service - the subscription is dead (uninstalled,
 *   permission revoked, browser data cleared) and the caller should stop
 *   retrying it / drop it from storage.
 */
export async function sendPush(subscription, payload) {
  if (!(await ensureConfigured())) return { ok: false };
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const expired = err.statusCode === 404 || err.statusCode === 410;
    if (!expired) console.error("[webpush] send failed:", err.statusCode, err.body || err.message);
    return { ok: false, expired };
  }
}
