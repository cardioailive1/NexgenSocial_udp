const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    const unique = `reel-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname) || ".webm"}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

const authorSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

// --- Discoverability ranking ---------------------------------------------
//
// This is the heart of the feature. A normal feed ranks by "who do you
// follow"; that's a reach ceiling. Short-form discovery ranks by whether
// the content HELD ATTENTION, which lets a good reel from an unknown
// creator outrank a mediocre one from someone with a big following. That
// asymmetry is exactly what makes it a top-of-funnel growth tool.
//
// Signals, in rough order of weight:
//  - completion rate: did people watch to the end? (strongest quality signal)
//  - replays: watched more than once = unusually strong
//  - engagement rate: likes+comments relative to views, NOT absolute counts
//    (absolute counts just re-privilege big accounts)
//  - new-audience reach: views from people who don't follow the author
//  - freshness decay: so the same evergreen reel doesn't own the feed forever

function rankScore(stats) {
  const { viewCount, completionRate, replayRate, engagementRate, newAudienceRate, ageHours } = stats;

  // Low-view reels have unreliable rates, so blend toward a neutral prior
  // until there's enough data. Without this, a reel with 1 view and 100%
  // completion would instantly top the feed.
  const confidence = Math.min(1, viewCount / 20);
  const neutral = 0.35;
  const blend = (rate) => rate * confidence + neutral * (1 - confidence);

  const quality =
    blend(completionRate) * 0.45 +
    blend(replayRate) * 0.20 +
    blend(engagementRate) * 0.20 +
    blend(newAudienceRate) * 0.15;

  // Halves roughly every 36 hours -- slower than the main feed, since reels
  // are meant to have longer shelf life than a timeline post.
  const freshness = 1 / (1 + ageHours / 36);

  return quality * 0.75 + freshness * 0.25;
}

function computeStats(reel) {
  const views = reel.views || [];
  const viewCount = views.length;
  const completions = views.filter((v) => v.completed).length;
  const replays = views.reduce((sum, v) => sum + (v.replayCount || 0), 0);
  const newAudienceViews = views.filter((v) => !v.viewerFollowedAuthor).length;
  const engagements = (reel._count?.likes || 0) + (reel._count?.comments || 0);

  return {
    viewCount,
    completionRate: viewCount ? completions / viewCount : 0,
    replayRate: viewCount ? Math.min(1, replays / viewCount) : 0,
    engagementRate: viewCount ? Math.min(1, engagements / viewCount) : 0,
    newAudienceRate: viewCount ? newAudienceViews / viewCount : 0,
    ageHours: (Date.now() - new Date(reel.createdAt).getTime()) / 3600000,
  };
}

function serialize(reel, viewerId, stats, score) {
  return {
    id: reel.id,
    videoUrl: reel.videoUrl,
    thumbnailUrl: reel.thumbnailUrl,
    caption: reel.caption,
    durationSec: reel.durationSec,
    soundName: reel.soundName,
    soundArtist: reel.soundArtist,
    isOriginalAudio: reel.isOriginalAudio,
    colorGrade: reel.colorGrade,
    createdAt: reel.createdAt,
    author: reel.author,
    hashtags: (reel.hashtags || []).map((rh) => rh.hashtag.tag),
    viewCount: stats?.viewCount ?? 0,
    likeCount: reel._count?.likes ?? 0,
    commentCount: reel._count?.comments ?? 0,
    likedByViewer: viewerId ? (reel.likes || []).some((l) => l.userId === viewerId) : false,
    // Surfaced so creators can see WHY a reel is or isn't reaching people --
    // the same transparency principle as "why am I seeing this" in the feed.
    discovery: stats
      ? {
          completionRate: +(stats.completionRate * 100).toFixed(1),
          replayRate: +(stats.replayRate * 100).toFixed(1),
          newAudienceRate: +(stats.newAudienceRate * 100).toFixed(1),
          rankScore: score != null ? +score.toFixed(4) : null,
        }
      : null,
  };
}

const reelInclude = {
  author: authorSelect,
  hashtags: { include: { hashtag: true } },
  views: { select: { completed: true, replayCount: true, viewerFollowedAuthor: true } },
  likes: { select: { userId: true } },
  _count: { select: { likes: true, comments: true } },
};

// --- Discovery feed ------------------------------------------------------
router.get("/discover", optionalAuth, async (req, res) => {
  const hashtag = (req.query.hashtag || "").toLowerCase().replace(/^#/, "");

  const reels = await prisma.reel.findMany({
    where: hashtag ? { hashtags: { some: { hashtag: { tag: hashtag } } } } : {},
    orderBy: { createdAt: "desc" },
    take: 200, // wide candidate pool; ranking below picks the order
    include: reelInclude,
  });

  const ranked = reels
    .map((reel) => {
      const stats = computeStats(reel);
      return { reel, stats, score: rankScore(stats) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  res.json({
    reels: ranked.map(({ reel, stats, score }) => serialize(reel, req.userId, stats, score)),
  });
});

// Reels by a specific creator (profile view)
router.get("/by/:username", optionalAuth, async (req, res) => {
  const author = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!author) return res.status(404).json({ error: "That user doesn't exist." });

  const reels = await prisma.reel.findMany({
    where: { authorId: author.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: reelInclude,
  });

  res.json({
    reels: reels.map((reel) => serialize(reel, req.userId, computeStats(reel), null)),
  });
});

// --- Publish -------------------------------------------------------------
router.post("/", requireAuth, upload.fields([{ name: "video", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  if (!videoFile) return res.status(400).json({ error: "A video file is required." });

  const { caption, durationSec, soundName, soundArtist, isOriginalAudio, colorGrade } = req.body || {};

  // Hashtags come from an explicit field AND are parsed out of the caption,
  // since people naturally type them inline.
  const rawTags = [
    ...(req.body.hashtags ? req.body.hashtags.split(",") : []),
    ...((caption || "").match(/#[\w]+/g) || []),
  ];
  const tags = [...new Set(
    rawTags
      .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
      .filter((t) => t.length > 0 && t.length <= 50)
  )].slice(0, 15);

  const reel = await prisma.reel.create({
    data: {
      authorId: req.userId,
      videoUrl: `/uploads/${videoFile.filename}`,
      thumbnailUrl: req.files?.thumbnail?.[0] ? `/uploads/${req.files.thumbnail[0].filename}` : null,
      caption: caption || null,
      durationSec: durationSec ? Number(durationSec) : null,
      soundName: soundName || null,
      soundArtist: soundArtist || null,
      isOriginalAudio: isOriginalAudio === "false" ? false : true,
      colorGrade: colorGrade || null,
      hashtags: {
        create: tags.map((tag) => ({
          hashtag: {
            connectOrCreate: { where: { tag }, create: { tag } },
          },
        })),
      },
    },
    include: reelInclude,
  });

  res.status(201).json({ reel: serialize(reel, req.userId, computeStats(reel), null) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const reel = await prisma.reel.findUnique({ where: { id: req.params.id } });
  if (!reel || reel.authorId !== req.userId) return res.status(404).json({ error: "Reel not found." });
  await prisma.reel.delete({ where: { id: reel.id } });
  res.status(204).end();
});

// --- View tracking (the ranking signal) ----------------------------------
router.post("/:id/view", requireAuth, async (req, res) => {
  const { watchedSec, completed } = req.body || {};
  const reel = await prisma.reel.findUnique({ where: { id: req.params.id } });
  if (!reel) return res.status(404).json({ error: "Reel not found." });

  const following = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: req.userId, followingId: reel.authorId } },
  });

  const existing = await prisma.reelView.findUnique({
    where: { reelId_viewerId: { reelId: reel.id, viewerId: req.userId } },
  });

  if (existing) {
    // A repeat view is a replay -- keep the highest watch time seen, and
    // once completed, stay completed.
    await prisma.reelView.update({
      where: { id: existing.id },
      data: {
        watchedSec: Math.max(existing.watchedSec, Number(watchedSec) || 0),
        completed: existing.completed || !!completed,
        replayCount: existing.replayCount + 1,
      },
    });
  } else {
    await prisma.reelView.create({
      data: {
        reelId: reel.id,
        viewerId: req.userId,
        watchedSec: Number(watchedSec) || 0,
        completed: !!completed,
        viewerFollowedAuthor: !!following,
      },
    });
  }
  res.status(201).json({ recorded: true });
});

// --- Engagement ----------------------------------------------------------
router.post("/:id/like", requireAuth, async (req, res) => {
  await prisma.reelLike.upsert({
    where: { reelId_userId: { reelId: req.params.id, userId: req.userId } },
    update: {},
    create: { reelId: req.params.id, userId: req.userId },
  });
  res.status(201).end();
});

router.delete("/:id/like", requireAuth, async (req, res) => {
  await prisma.reelLike.deleteMany({ where: { reelId: req.params.id, userId: req.userId } });
  res.status(204).end();
});

router.get("/:id/comments", async (req, res) => {
  const comments = await prisma.reelComment.findMany({
    where: { reelId: req.params.id },
    orderBy: { createdAt: "asc" },
    include: { author: authorSelect },
  });
  res.json({ comments });
});

router.post("/:id/comments", requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "Comment can't be empty." });

  const comment = await prisma.reelComment.create({
    data: { reelId: req.params.id, authorId: req.userId, body },
    include: { author: authorSelect },
  });
  res.status(201).json({ comment });
});

// --- Trending hashtags ---------------------------------------------------
// Ranked by recent activity rather than all-time volume, so the list
// actually reflects what's happening now.
router.get("/hashtags/trending", async (_req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const recent = await prisma.reelHashtag.findMany({
    where: { reel: { createdAt: { gte: since } } },
    include: { hashtag: true },
  });

  const counts = new Map();
  for (const rh of recent) {
    counts.set(rh.hashtag.tag, (counts.get(rh.hashtag.tag) || 0) + 1);
  }

  const trending = [...counts.entries()]
    .map(([tag, count]) => ({ tag, reelCount: count }))
    .sort((a, b) => b.reelCount - a.reelCount)
    .slice(0, 20);

  res.json({ trending, windowDays: 7 });
});

module.exports = router;
