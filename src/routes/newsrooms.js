const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `news-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ""}`);
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

const ownerSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// --- Newsrooms -----------------------------------------------------------

router.get("/", optionalAuth, async (req, res) => {
  const beat = (req.query.beat || "").toString().trim();
  const newsrooms = await prisma.newsroom.findMany({
    where: { ...(beat && { beat }) },
    orderBy: [{ verified: "desc" }, { createdAt: "desc" }],
    take: 100,
    include: {
      owner: ownerSelect,
      media: true,
      _count: { select: { articles: true, followers: true } },
    },
  });

  let followed = new Set();
  if (req.userId) {
    const rows = await prisma.newsroomFollower.findMany({
      where: { userId: req.userId, newsroomId: { in: newsrooms.map((n) => n.id) } },
      select: { newsroomId: true },
    });
    followed = new Set(rows.map((r) => r.newsroomId));
  }

  // Which newsrooms are broadcasting right now -- surfaced in the list so
  // a live broadcast is discoverable without opening each page.
  const liveStreams = await prisma.livestream.findMany({
    where: { status: "LIVE", newsroomId: { in: newsrooms.map((n) => n.id) } },
    select: { id: true, title: true, newsroomId: true },
  });
  const liveByNewsroom = new Map(liveStreams.map((s) => [s.newsroomId, s]));

  res.json({
    newsrooms: newsrooms.map((n) => ({
      id: n.id,
      name: n.name,
      slug: n.slug,
      description: n.description,
      organization: n.organization,
      websiteUrl: n.websiteUrl,
      avatarUrl: n.avatarUrl,
      coverUrl: n.coverUrl,
      media: n.media,
      beat: n.beat,
      region: n.region,
      verified: n.verified,
      createdAt: n.createdAt,
      owner: n.owner,
      articleCount: n._count.articles,
      followerCount: n._count.followers,
      followedByViewer: followed.has(n.id),
      liveNow: liveByNewsroom.get(n.id) || null,
    })),
  });
});

router.post("/", requireAuth, upload.fields([
  { name: "avatar", maxCount: 1 },
  { name: "cover", maxCount: 1 },
  { name: "media", maxCount: 10 },
]), async (req, res) => {
  const { name, description, organization, websiteUrl, beat, region } = req.body || {};
  if (!name || !organization) {
    // Same reasoning as political pages: a newsroom with no named
    // organisation behind it is exactly what readers can't evaluate.
    return res.status(400).json({ error: "A newsroom name and the responsible organization are both required." });
  }

  let slug = slugify(name);
  if (!slug) return res.status(400).json({ error: "That name can't be turned into a URL. Try adding letters or numbers." });

  // Slugs are unique; append a short suffix rather than failing outright.
  const existing = await prisma.newsroom.findUnique({ where: { slug } });
  if (existing) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const newsroom = await prisma.newsroom.create({
    data: {
      ownerId: req.userId,
      name,
      slug,
      description: description || null,
      organization,
      websiteUrl: websiteUrl || null,
      beat: beat || null,
      region: region || null,
      avatarUrl: req.files?.avatar?.[0] ? `/uploads/${req.files.avatar[0].filename}` : null,
      coverUrl: req.files?.cover?.[0] ? `/uploads/${req.files.cover[0].filename}` : null,
      media: {
        create: (req.files?.media || []).map((f, i) => ({
          url: `/uploads/${f.filename}`,
          kind: mediaKind(f),
          position: i,
        })),
      },
    },
    include: { owner: ownerSelect, media: true },
  });
  res.status(201).json({ newsroom });
});

router.get("/:slug", optionalAuth, async (req, res) => {
  const newsroom = await prisma.newsroom.findUnique({
    where: { slug: req.params.slug },
    include: {
      owner: ownerSelect,
      articles: { orderBy: [{ isBreaking: "desc" }, { publishedAt: "desc" }], take: 50, include: { media: true } },
      media: true,
      _count: { select: { followers: true } },
    },
  });
  if (!newsroom) return res.status(404).json({ error: "Newsroom not found." });

  const [followedByViewer, liveNow] = await Promise.all([
    req.userId
      ? prisma.newsroomFollower.findUnique({
          where: { newsroomId_userId: { newsroomId: newsroom.id, userId: req.userId } },
        })
      : null,
    prisma.livestream.findFirst({
      where: { newsroomId: newsroom.id, status: "LIVE" },
      select: { id: true, title: true, startedAt: true },
    }),
  ]);

  res.json({
    newsroom: {
      ...newsroom,
      followerCount: newsroom._count.followers,
      followedByViewer: !!followedByViewer,
      liveNow,
      isOwner: req.userId === newsroom.ownerId,
    },
  });
});

router.post("/:id/follow", requireAuth, async (req, res) => {
  await prisma.newsroomFollower.upsert({
    where: { newsroomId_userId: { newsroomId: req.params.id, userId: req.userId } },
    update: {},
    create: { newsroomId: req.params.id, userId: req.userId },
  });
  res.status(201).end();
});

router.delete("/:id/follow", requireAuth, async (req, res) => {
  await prisma.newsroomFollower.deleteMany({
    where: { newsroomId: req.params.id, userId: req.userId },
  });
  res.status(204).end();
});

router.post("/:id/media", requireAuth, upload.array("media", 10), async (req, res) => {
  const newsroom = await prisma.newsroom.findUnique({
    where: { id: req.params.id },
    include: { media: true },
  });
  if (!newsroom || newsroom.ownerId !== req.userId) return res.status(404).json({ error: "Newsroom not found." });

  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: "No files received." });

  await prisma.newsroomMedia.createMany({
    data: files.map((f, i) => ({
      newsroomId: newsroom.id,
      url: `/uploads/${f.filename}`,
      kind: mediaKind(f),
      position: newsroom.media.length + i,
    })),
  });

  const updated = await prisma.newsroom.findUnique({
    where: { id: newsroom.id },
    include: { media: true },
  });
  res.status(201).json({ media: updated.media });
});

// --- Articles ------------------------------------------------------------

router.post("/:id/articles", requireAuth, upload.array("media", 10), async (req, res) => {
  const newsroom = await prisma.newsroom.findUnique({ where: { id: req.params.id } });
  if (!newsroom || newsroom.ownerId !== req.userId) {
    return res.status(404).json({ error: "Newsroom not found." });
  }

  const { headline, standfirst, body, byline, isBreaking, captions } = req.body || {};
  if (!headline || !body) return res.status(400).json({ error: "A headline and body are required." });

  // Captions arrive as a JSON array matching file order, so a photo credit
  // stays attached to the right image.
  let captionList = [];
  try { captionList = captions ? JSON.parse(captions) : []; } catch { captionList = []; }

  const files = req.files || [];
  const article = await prisma.newsArticle.create({
    data: {
      newsroomId: newsroom.id,
      headline,
      standfirst: standfirst || null,
      body,
      byline: byline || null,
      isBreaking: isBreaking === "true" || isBreaking === true,
      media: {
        create: files.map((f, i) => ({
          url: `/uploads/${f.filename}`,
          kind: mediaKind(f),
          caption: captionList[i] || null,
          position: i,
        })),
      },
    },
    include: { media: true },
  });
  res.status(201).json({ article });
});

router.patch("/articles/:articleId", requireAuth, async (req, res) => {
  const article = await prisma.newsArticle.findUnique({
    where: { id: req.params.articleId },
    include: { newsroom: true },
  });
  if (!article || article.newsroom.ownerId !== req.userId) {
    return res.status(404).json({ error: "Article not found." });
  }

  const { headline, standfirst, body, byline, isBreaking } = req.body || {};
  // Editing the body of a published article marks it as corrected. News
  // that changes silently after publication is a real trust problem, so
  // the correction is recorded and displayed rather than hidden.
  const bodyChanged = body !== undefined && body !== article.body;

  const updated = await prisma.newsArticle.update({
    where: { id: article.id },
    data: {
      ...(headline !== undefined && { headline }),
      ...(standfirst !== undefined && { standfirst: standfirst || null }),
      ...(body !== undefined && { body }),
      ...(byline !== undefined && { byline: byline || null }),
      ...(isBreaking !== undefined && { isBreaking: !!isBreaking }),
      ...(bodyChanged && { correctedAt: new Date() }),
    },
  });
  res.json({ article: updated });
});

router.delete("/articles/:articleId", requireAuth, async (req, res) => {
  const article = await prisma.newsArticle.findUnique({
    where: { id: req.params.articleId },
    include: { newsroom: true },
  });
  if (!article || article.newsroom.ownerId !== req.userId) {
    return res.status(404).json({ error: "Article not found." });
  }
  await prisma.newsArticle.delete({ where: { id: article.id } });
  res.status(204).end();
});

// --- Combined coverage feed ---------------------------------------------
// Articles from every newsroom, breaking first. This is the "Media
// Coverage" landing view, distinct from the RSS headlines in /api/news
// which aggregate external outlets.
router.get("/feed/latest", optionalAuth, async (_req, res) => {
  const articles = await prisma.newsArticle.findMany({
    orderBy: [{ isBreaking: "desc" }, { publishedAt: "desc" }],
    take: 60,
    include: {
      newsroom: { select: { id: true, name: true, slug: true, organization: true, verified: true, avatarUrl: true } },
      media: true,
    },
  });
  res.json({ articles });
});

module.exports = router;
