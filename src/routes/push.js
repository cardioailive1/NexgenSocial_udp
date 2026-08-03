const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isPushConfigured } = require("../lib/push");

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

module.exports = router;
