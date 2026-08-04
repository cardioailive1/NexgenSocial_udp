const http2 = require("http2");
const jwt = require("jsonwebtoken");
const prisma = require("./prisma");

// Apple Push Notification service.
//
// Talks to Apple's HTTP/2 API directly rather than pulling in node-apn.
// The protocol is small, and one fewer dependency matters for something
// that holds a signing key.
//
// Two distinctions that cause most APNs bugs, both handled here:
//   * ALERT vs VOIP tokens are different values and need different
//     `apns-push-type` and topic suffixes. Crossing them fails silently.
//   * Sandbox (development builds) and production (TestFlight/App Store)
//     are separate gateways. A token from one is rejected by the other.

const HOSTS = {
  SANDBOX: "https://api.sandbox.push.apple.com",
  PRODUCTION: "https://api.push.apple.com",
};

let cachedToken = null;
let cachedAt = 0;

function isApnsConfigured() {
  return !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);
}

// Apple rejects provider tokens older than 1 hour and rate-limits
// regenerating them too often, so it's cached and refreshed at ~50 minutes.
function providerToken() {
  const now = Date.now();
  if (cachedToken && now - cachedAt < 50 * 60 * 1000) return cachedToken;

  // The key arrives as an env var, where real newlines are awkward --
  // accept the common "\n" escaped form as well.
  const key = process.env.APNS_KEY_P8.replace(/\\n/g, "\n");

  cachedToken = jwt.sign({}, key, {
    algorithm: "ES256",
    issuer: process.env.APNS_TEAM_ID,
    header: { alg: "ES256", kid: process.env.APNS_KEY_ID },
    expiresIn: "55m",
  });
  cachedAt = now;
  return cachedToken;
}

function sendOne({ host, topic, deviceToken, payload, pushType, expiration }) {
  return new Promise((resolve) => {
    const client = http2.connect(host);
    client.on("error", (err) => resolve({ ok: false, reason: err.message }));

    const body = JSON.stringify(payload);
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "authorization": `bearer ${providerToken()}`,
      "apns-topic": topic,
      "apns-push-type": pushType,
      // Calls must arrive immediately; 10 is the only valid priority for
      // an alert that should wake the device now.
      "apns-priority": "10",
      "apns-expiration": String(expiration ?? 0),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });

    let status = 0;
    let responseBody = "";

    request.on("response", (headers) => { status = headers[":status"]; });
    request.setEncoding("utf8");
    request.on("data", (chunk) => { responseBody += chunk; });
    request.on("end", () => {
      client.close();
      if (status === 200) return resolve({ ok: true });
      let reason = responseBody;
      try { reason = JSON.parse(responseBody).reason || responseBody; } catch {}
      resolve({ ok: false, status, reason });
    });
    request.on("error", (err) => {
      client.close();
      resolve({ ok: false, reason: err.message });
    });

    request.write(body);
    request.end();
  });
}

/// Standard alert push -- messages, mentions, and so on.
async function sendApnsAlert(userId, { title, body, url, badge }) {
  if (!isApnsConfigured()) return { sent: 0, skipped: true };

  const devices = await prisma.apnsDevice.findMany({ where: { userId, kind: "ALERT" } });
  if (devices.length === 0) return { sent: 0, noDevices: true };

  const bundleId = process.env.APNS_BUNDLE_ID || "com.corverxis.nexgensocial";
  let sent = 0;

  for (const device of devices) {
    const result = await sendOne({
      host: HOSTS[device.environment] || HOSTS.PRODUCTION,
      topic: bundleId,
      deviceToken: device.token,
      pushType: "alert",
      expiration: Math.floor(Date.now() / 1000) + 3600,
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          ...(badge != null && { badge }),
        },
        url: url || "/",
      },
    });

    if (result.ok) sent++;
    else await handleFailure(device, result);
  }
  return { sent, total: devices.length };
}

/// VoIP push for an incoming call.
///
/// This is what makes a terminated app ring. Note the strict contract: iOS
/// KILLS the app if it receives a VoIP push and doesn't report a call to
/// CallKit, so this must only ever be sent for a genuine incoming call --
/// never as a general-purpose wake-up.
async function sendApnsVoIPCall(userId, { callId, callerName, kind }) {
  if (!isApnsConfigured()) return { sent: 0, skipped: true };

  const devices = await prisma.apnsDevice.findMany({ where: { userId, kind: "VOIP" } });
  if (devices.length === 0) return { sent: 0, noDevices: true };

  const bundleId = process.env.APNS_BUNDLE_ID || "com.corverxis.nexgensocial";
  let sent = 0;

  for (const device of devices) {
    const result = await sendOne({
      host: HOSTS[device.environment] || HOSTS.PRODUCTION,
      // VoIP pushes use the bundle id with a .voip suffix -- a plain
      // bundle id here returns TopicDisallowed.
      topic: `${bundleId}.voip`,
      deviceToken: device.token,
      pushType: "voip",
      // A ring is worthless if delivered late, so it expires in 30s
      // rather than sitting in a queue.
      expiration: Math.floor(Date.now() / 1000) + 30,
      payload: { callId, callerName, kind },
    });

    if (result.ok) sent++;
    else await handleFailure(device, result);
  }
  return { sent, total: devices.length };
}

// Apple tells us when a token is dead. Deleting it stops us retrying
// forever against a device that uninstalled the app.
async function handleFailure(device, result) {
  const dead = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"];
  if (dead.includes(result.reason)) {
    await prisma.apnsDevice.delete({ where: { id: device.id } }).catch(() => {});
    console.log(`Removed dead APNs token (${result.reason}) for user ${device.userId}`);
  } else {
    console.error(`APNs send failed [${result.status}]: ${result.reason}`);
  }
}

function initApns() {
  if (!isApnsConfigured()) {
    console.log("APNs not configured (APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID missing) -- iOS calls will only ring with the app open.");
    return false;
  }
  try {
    providerToken(); // fail fast on a malformed key rather than at first send
    console.log("APNs configured.");
    return true;
  } catch (err) {
    console.error("APNs key is invalid:", err.message);
    return false;
  }
}

module.exports = { initApns, isApnsConfigured, sendApnsAlert, sendApnsVoIPCall };
