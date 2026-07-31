const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `political-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ""}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Only photos and videos can be attached."));
  },
});

function mediaKind(file) {
  return file.mimetype.startsWith("video") ? "VIDEO" : "PHOTO";
}

const PAGE_TYPES = ["CANDIDATE", "PARTY", "ISSUE", "CAMPAIGN", "ORGANIZATION"];
const ownerSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

// --- Pages ---------------------------------------------------------------

router.get("/pages", optionalAuth, async (req, res) => {
  const type = (req.query.type || "").toUpperCase();
  const pages = await prisma.politicalPage.findMany({
    where: { ...(PAGE_TYPES.includes(type) && { type }) },
    orderBy: [{ verified: "desc" }, { createdAt: "desc" }],
    take: 100,
    include: { owner: ownerSelect, _count: { select: { followers: true, posts: true, ads: true } } },
  });

  let followedIds = new Set();
  if (req.userId) {
    const rows = await prisma.politicalPageFollower.findMany({
      where: { userId: req.userId, pageId: { in: pages.map((p) => p.id) } },
      select: { pageId: true },
    });
    followedIds = new Set(rows.map((r) => r.pageId));
  }

  res.json({
    pages: pages.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      description: p.description,
      organization: p.organization,
      websiteUrl: p.websiteUrl,
      region: p.region,
      avatarUrl: p.avatarUrl,
      verified: p.verified,
      createdAt: p.createdAt,
      owner: p.owner,
      followerCount: p._count.followers,
      postCount: p._count.posts,
      adCount: p._count.ads,
      followedByViewer: followedIds.has(p.id),
    })),
  });
});

router.post("/pages", requireAuth, upload.fields([{ name: "avatar", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
  const { type, name, description, organization, websiteUrl, region } = req.body || {};
  if (!PAGE_TYPES.includes(type)) {
    return res.status(400).json({ error: "Choose a valid page type." });
  }
  if (!name || !organization) {
    // Enforced at the API level, not just in the form: an anonymous
    // political page is precisely what disclosure rules exist to prevent,
    // so it can't be bypassed by posting directly to the endpoint.
    return res.status(400).json({ error: "A page name and the responsible organization are both required." });
  }

  const page = await prisma.politicalPage.create({
    data: {
      ownerId: req.userId,
      type,
      name,
      description: description || null,
      organization,
      websiteUrl: websiteUrl || null,
      region: region || null,
      avatarUrl: req.files?.avatar?.[0] ? `/uploads/${req.files.avatar[0].filename}` : null,
      coverUrl: req.files?.cover?.[0] ? `/uploads/${req.files.cover[0].filename}` : null,
    },
    include: { owner: ownerSelect },
  });
  res.status(201).json({ page });
});

router.get("/pages/:id", optionalAuth, async (req, res) => {
  const page = await prisma.politicalPage.findUnique({
    where: { id: req.params.id },
    include: {
      owner: ownerSelect,
      posts: { orderBy: { createdAt: "desc" }, take: 50, include: { media: true } },
      _count: { select: { followers: true } },
    },
  });
  if (!page) return res.status(404).json({ error: "Page not found." });

  let followedByViewer = false;
  if (req.userId) {
    followedByViewer = !!(await prisma.politicalPageFollower.findUnique({
      where: { pageId_userId: { pageId: page.id, userId: req.userId } },
    }));
  }

  res.json({ page: { ...page, followerCount: page._count.followers, followedByViewer } });
});

router.post("/pages/:id/follow", requireAuth, async (req, res) => {
  await prisma.politicalPageFollower.upsert({
    where: { pageId_userId: { pageId: req.params.id, userId: req.userId } },
    update: {},
    create: { pageId: req.params.id, userId: req.userId },
  });
  res.status(201).end();
});

router.delete("/pages/:id/follow", requireAuth, async (req, res) => {
  await prisma.politicalPageFollower.deleteMany({
    where: { pageId: req.params.id, userId: req.userId },
  });
  res.status(204).end();
});

router.post("/pages/:id/posts", requireAuth, upload.array("media", 10), async (req, res) => {
  const page = await prisma.politicalPage.findUnique({ where: { id: req.params.id } });
  if (!page || page.ownerId !== req.userId) return res.status(404).json({ error: "Page not found." });

  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "Write something to post." });

  const files = req.files || [];
  const post = await prisma.politicalPost.create({
    data: {
      pageId: page.id,
      body,
      media: {
        create: files.map((f, i) => ({
          url: `/uploads/${f.filename}`,
          kind: mediaKind(f),
          position: i,
        })),
      },
    },
    include: { media: true },
  });
  res.status(201).json({ post });
});

router.get("/pages/:id/posts", optionalAuth, async (req, res) => {
  const posts = await prisma.politicalPost.findMany({
    where: { pageId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { media: true },
  });
  res.json({ posts });
});

// --- Political ads -------------------------------------------------------

router.post("/ads", requireAuth, upload.single("media"), async (req, res) => {
  const { pageId, headline, body, targetUrl, paidForBy, spendCents, region } = req.body || {};

  const page = await prisma.politicalPage.findUnique({ where: { id: pageId } });
  if (!page || page.ownerId !== req.userId) {
    return res.status(404).json({ error: "You can only run ads from a political page you own." });
  }
  if (!headline || !body) return res.status(400).json({ error: "Headline and body are required." });
  if (!paidForBy || !paidForBy.trim()) {
    // Hard requirement, enforced server-side. In the US the FEC requires a
    // "paid for by" disclaimer on political advertising; the EU's political
    // advertising rules are comparable. Making this optional would push a
    // legal problem onto whoever runs the platform.
    return res.status(400).json({
      error: 'A "Paid for by" disclosure is legally required on political ads and cannot be left blank.',
    });
  }

  const ad = await prisma.politicalAd.create({
    data: {
      pageId: page.id,
      headline,
      body,
      targetUrl: targetUrl || null,
      mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
      mediaKind: req.file ? mediaKind(req.file) : null,
      paidForBy,
      spendCents: spendCents ? Math.round(Number(spendCents)) : 0,
      region: region || page.region || null,
    },
  });
  res.status(201).json({ ad });
});

router.post("/ads/:id/end", requireAuth, async (req, res) => {
  const ad = await prisma.politicalAd.findUnique({
    where: { id: req.params.id },
    include: { page: true },
  });
  if (!ad || ad.page.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });

  const updated = await prisma.politicalAd.update({
    where: { id: ad.id },
    data: { active: false, endedAt: new Date() },
  });
  res.json({ ad: updated });
});

router.post("/ads/:id/event", optionalAuth, async (req, res) => {
  const { type } = req.body || {};
  if (!["IMPRESSION", "CLICK"].includes(type)) {
    return res.status(400).json({ error: "type must be IMPRESSION or CLICK." });
  }
  await prisma.politicalAd.update({
    where: { id: req.params.id },
    data: type === "IMPRESSION" ? { impressions: { increment: 1 } } : { clicks: { increment: 1 } },
  });
  res.status(201).end();
});

// --- Public ad archive ---------------------------------------------------
//
// Deliberately unauthenticated and includes ENDED ads, not just running
// ones. That combination is the whole point: transparency regulations
// (EU DSA/TTPA, and the direction US rules are heading) expect political
// advertising to remain publicly inspectable after a campaign finishes,
// which is exactly when there's most incentive to make it disappear.
// Meta and Google both run archives like this for the same reason.
router.get("/archive", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const region = (req.query.region || "").toString().trim();

  const ads = await prisma.politicalAd.findMany({
    where: {
      ...(region && { region }),
      ...(q && {
        OR: [
          { headline: { contains: q, mode: "insensitive" } },
          { body: { contains: q, mode: "insensitive" } },
          { paidForBy: { contains: q, mode: "insensitive" } },
        ],
      }),
    },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { page: { select: { id: true, name: true, organization: true, type: true, verified: true } } },
  });

  res.json({
    ads: ads.map((ad) => ({
      id: ad.id,
      headline: ad.headline,
      body: ad.body,
      imageUrl: ad.imageUrl,
      mediaUrl: ad.mediaUrl,
      mediaKind: ad.mediaKind,
      targetUrl: ad.targetUrl,
      paidForBy: ad.paidForBy,
      spendCents: ad.spendCents,
      region: ad.region,
      active: ad.active,
      startedAt: ad.startedAt,
      endedAt: ad.endedAt,
      impressions: ad.impressions,
      clicks: ad.clicks,
      page: ad.page,
    })),
    note: "Every political ad ever run on NexgenSocial appears here, including ads that have ended.",
  });
});

// Ads currently eligible to be shown in-feed.
router.get("/ads/active", optionalAuth, async (_req, res) => {
  const ads = await prisma.politicalAd.findMany({
    where: { active: true },
    orderBy: { startedAt: "desc" },
    take: 20,
    include: { page: { select: { id: true, name: true, organization: true, verified: true } } },
  });
  res.json({ ads });
});

module.exports = router;
