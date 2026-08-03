// Web Push delivery. Lets a call or message reach someone whose tab is
// closed or minimised.
//
// The honest limit, worth stating plainly: this requires the BROWSER to be
// running. Backgrounded, minimised, other tabs -- all fine. Fully quit, or
// swiped away on mobile -- nothing arrives. Waking a device from cold
// needs a native app; no amount of web code changes that.
const prisma = require("./prisma");

let webpush = null;
let configured = false;

function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@nexgensocialnet.com";

  if (!publicKey || !privateKey) {
    console.log("Web Push not configured (VAPID keys missing) -- calls will only ring in an open tab.");
    return false;
  }
  try {
    webpush = require("web-push");
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
    console.log("Web Push configured.");
    return true;
  } catch (err) {
    console.error("Web Push failed to initialise:", err.message);
    return false;
  }
}

function isPushConfigured() {
  return configured;
}

// Sends to every device this person has registered. Failures are handled
// per-subscription: a 404/410 means the browser dropped it, so we delete
// it rather than retrying forever against a dead endpoint.
async function sendPushToUser(userId, payload) {
  if (!configured || !webpush) return { sent: 0, skipped: true };

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return { sent: 0, noSubscriptions: true };

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60, urgency: "high" } // calls are time-sensitive; don't queue them for later
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        console.error("Push send failed:", err.statusCode, err.body || err.message);
      }
    }
  }));

  return { sent, total: subs.length };
}

module.exports = { initPush, isPushConfigured, sendPushToUser };
