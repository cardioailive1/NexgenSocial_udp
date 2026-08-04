const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isPushConfigured } = require("../lib/push");
const { isApnsConfigured } = require("../lib/apns");

const router = express.Router();

// The browser needs this to subscribe. Public by design -- the VAPID
// public key is meant to be shared; only the private key is secret.
router.get("/vapid-key", (_req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
    configured: isPushConfigured(),
  });
});

router.post("/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Invalid push subscription." });
  }

  // Upsert on endpoint: the same browser re-subscribing shouldn't create
  // duplicates and send the same person two notifications.
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.userId, p256dh: keys.p256dh, auth: keys.auth },
    create: {
      userId: req.userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.headers["user-agent"] || null,
    },
  });
  res.status(201).json({ subscribed: true, id: sub.id });
});

router.post("/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId } });
  }
  res.status(204).end();
});

router.get("/status", requireAuth, async (req, res) => {
  const count = await prisma.pushSubscription.count({ where: { userId: req.userId } });
  res.json({ configured: isPushConfigured(), deviceCount: count });
});

// --- APNs (native iOS) ----------------------------------------------------

function normalizeEnvironment(value) {
  return String(value || "").toLowerCase() === "sandbox" ? "SANDBOX" : "PRODUCTION";
}

// Standard alert token, used for messages and other notifications.
router.post("/apns-subscribe", requireAuth, async (req, res) => {
  const { deviceToken, environment, bundleId } = req.body || {};
  if (!deviceToken || typeof deviceToken !== "string") {
    return res.status(400).json({ error: "A device token is required." });
  }

  // Upsert on (token, kind): reinstalling the app or restoring a backup
  // can hand the same token to a different account, and the row should
  // follow the current owner rather than notifying the previous one.
  const device = await prisma.apnsDevice.upsert({
    where: { token_kind: { token: deviceToken, kind: "ALERT" } },
    update: {
      userId: req.userId,
      environment: normalizeEnvironment(environment),
      bundleId: bundleId || null,
    },
    create: {
      userId: req.userId,
      token: deviceToken,
      kind: "ALERT",
      environment: normalizeEnvironment(environment),
      bundleId: bundleId || null,
    },
  });

  res.status(201).json({ subscribed: true, id: device.id, configured: isApnsConfigured() });
});

// VoIP token -- the one that makes a terminated app ring via CallKit.
router.post("/voip-subscribe", requireAuth, async (req, res) => {
  const { voipToken, environment, bundleId } = req.body || {};
  if (!voipToken || typeof voipToken !== "string") {
    return res.status(400).json({ error: "A VoIP token is required." });
  }

  const device = await prisma.apnsDevice.upsert({
    where: { token_kind: { token: voipToken, kind: "VOIP" } },
    update: {
      userId: req.userId,
      environment: normalizeEnvironment(environment),
      bundleId: bundleId || null,
    },
    create: {
      userId: req.userId,
      token: voipToken,
      kind: "VOIP",
      environment: normalizeEnvironment(environment),
      bundleId: bundleId || null,
    },
  });

  res.status(201).json({ subscribed: true, id: device.id, configured: isApnsConfigured() });
});

router.post("/apns-unsubscribe", requireAuth, async (req, res) => {
  const { deviceToken, voipToken } = req.body || {};
  const token = deviceToken || voipToken;
  if (token) {
    await prisma.apnsDevice.deleteMany({ where: { token, userId: req.userId } });
  }
  res.status(204).end();
});

router.post("/voip-unsubscribe", requireAuth, async (req, res) => {
  const { voipToken } = req.body || {};
  if (voipToken) {
    await prisma.apnsDevice.deleteMany({ where: { token: voipToken, userId: req.userId } });
  }
  res.status(204).end();
});

// Combined status, so the client can tell what's actually reachable.
router.get("/devices", requireAuth, async (req, res) => {
  const devices = await prisma.apnsDevice.findMany({
    where: { userId: req.userId },
    select: { id: true, kind: true, environment: true, createdAt: true },
  });
  const webCount = await prisma.pushSubscription.count({ where: { userId: req.userId } });

  res.json({
    apnsConfigured: isApnsConfigured(),
    webPushConfigured: isPushConfigured(),
    apnsDevices: devices,
    webDeviceCount: webCount,
  });
});

module.exports = router;
