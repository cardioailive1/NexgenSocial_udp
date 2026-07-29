const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

async function loadTier(req, res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "Account not found." });
  req.tier = user.tier;
  next();
}

function gatePremium(req, res, next) {
  if (req.tier !== "PREMIUM") {
    return res.status(402).json({ error: "This feature is part of NexgenSocial Premium." });
  }
  next();
}

// --- Subscription (stubbed: swap the body of this handler for a real
// payment-provider webhook confirmation before going live) ---
router.post("/upgrade", requireAuth, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.userId }, data: { tier: "PREMIUM" } });
  res.json({ tier: user.tier });
});

router.post("/downgrade", requireAuth, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.userId }, data: { tier: "FREE" } });
  res.json({ tier: user.tier });
});

// --- Marketplace ---
router.get("/marketplace", async (_req, res) => {
  const listings = await prisma.marketListing.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { seller: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  res.json({ listings });
});

router.post("/marketplace", requireAuth, loadTier, gatePremium, async (req, res) => {
  const { title, description, priceCents, imageUrl } = req.body || {};
  if (!title || !description || !priceCents) {
    return res.status(400).json({ error: "Title, description, and price are required." });
  }
  const listing = await prisma.marketListing.create({
    data: { sellerId: req.userId, title, description, priceCents, imageUrl: imageUrl || null },
  });
  res.status(201).json({ listing });
});

// --- Ads (business or political) ---
router.get("/ads", async (req, res) => {
  const category = req.query.category; // BUSINESS | POLITICAL | GENERAL
  const ads = await prisma.ad.findMany({
    where: { active: true, ...(category && { category }) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ ads });
});

router.post("/ads", requireAuth, loadTier, gatePremium, async (req, res) => {
  const { category, headline, body, imageUrl, targetUrl } = req.body || {};
  if (!headline || !body) return res.status(400).json({ error: "Headline and body are required." });

  const ad = await prisma.ad.create({
    data: {
      ownerId: req.userId,
      category: category || "GENERAL",
      headline,
      body,
      imageUrl: imageUrl || null,
      targetUrl: targetUrl || null,
    },
  });
  res.status(201).json({ ad });
});

// --- Political hub & media coverage / live streams: scaffolded endpoints.
// These currently reuse Group + Post (a "political" or "media" group is just
// a Group with a topic), which is enough to build the feature end to end.
// A dedicated Livestream model (RTMP/HLS ingest URL, viewer count, chat)
// is the natural next addition once you pick a streaming provider
// (e.g. Mux, Cloudflare Stream) — see README "Next build steps".
router.get("/status", requireAuth, loadTier, (req, res) => {
  res.json({ tier: req.tier });
});

module.exports = router;
