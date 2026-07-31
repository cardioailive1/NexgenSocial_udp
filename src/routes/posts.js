const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

// NOTE on Render: local disk storage is ephemeral (wiped on redeploy/restart).
// For production video/image uploads, swap this out for direct-to-S3 (or
// Cloudflare R2 / Render Disks with a persistent disk attached) and store
// only the resulting URL here. This local setup is fine for development.
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname) || ".webm"}`);
  },
});
// 500MB cap. A 10-minute in-browser recording (see MAX_SECONDS in
// QuickVideoRecorder.jsx) can realistically approach or exceed 200MB
// depending on the browser's default bitrate and camera resolution --
// this leaves real headroom instead of the two limits fighting each
// other, where a recording finishes fine but then fails at the very last
// step (upload) with a confusing error.
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const postAuthorSelect = { id: true, username: true, displayName: true, avatarUrl: true };

// --- Adjustable feed algorithm --------------------------------------------
// Each person sets their own recency/engagement/diversity weights (see
// routes/users.js). We score every candidate post against those weights,
// then do a light diversity re-ranking pass so one prolific author can't
// dominate the top of the feed when diversity is turned up. Every post also
// gets a plain-language `reason` and a `scoreBreakdown` so "why am I seeing
// this" is answerable for every single item, not just a marketing claim.

function recencyScore(createdAt) {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  return 1 / (1 + ageHours / 12); // halves roughly every 12 hours
}

function engagementScore(post) {
  const likeCount = post._count?.likes ?? 0;
  const commentCount = post._count?.comments ?? 0;
  return 1 - 1 / (1 + likeCount + commentCount * 2); // diminishing returns, comments weighted higher
}

function reasonFor(post, viewerId, friendIds, followingIds) {
  if (post.authorId === viewerId) return "Your post";
  if (friendIds.has(post.authorId)) return `You're friends with @${post.author.username}`;
  if (followingIds.has(post.authorId)) return `You follow @${post.author.username}`;
  if (post.groupId) return "Posted in a group you're in";
  return "Public post";
}

function scoreAndRank(posts, weights, viewerId, friendIds, followingIds) {
  const scored = posts.map((post) => {
    const rec = recencyScore(post.createdAt);
    const eng = engagementScore(post);
    const breakdown = {
      recency: Number((rec * weights.recency).toFixed(3)),
      engagement: Number((eng * weights.engagement).toFixed(3)),
    };
    const score = breakdown.recency + breakdown.engagement;
    return { post, score, breakdown, reason: reasonFor(post, viewerId, friendIds, followingIds) };
  });

  scored.sort((a, b) => b.score - a.score);

  // Diversity pass: walk the ranked list and demote a post if its author
  // already appears among the last N picks, proportional to the diversity
  // weight. At diversity=0 this is a no-op (pure score order).
  const windowSize = Math.max(1, Math.round(5 * weights.diversity));
  const result = [];
  const pool = [...scored];
  while (pool.length) {
    const recentAuthors = result.slice(-windowSize).map((r) => r.post.authorId);
    let pickIndex = pool.findIndex((item) => !recentAuthors.includes(item.post.authorId));
    if (pickIndex === -1) pickIndex = 0; // everyone left is a repeat author -- just take the top-scored one
    result.push(pool.splice(pickIndex, 1)[0]);
  }
  return result;
}

function serialize(entry, viewerId) {
  const { post, score, breakdown, reason } = entry;
  return {
    id: post.id,
    type: post.type,
    body: post.body,
    mediaUrl: post.mediaUrl,
    groupId: post.groupId,
    audience: post.audience,
    circleId: post.circleId,
    category: post.category,
    isAiGenerated: post.isAiGenerated,
    aiTool: post.aiTool,
    editedAt: post.editedAt,
    createdAt: post.createdAt,
    author: post.author,
    likeCount: post._count?.likes ?? post.likes?.length ?? 0,
    commentCount: post._count?.comments ?? post.comments?.length ?? 0,
    likedByViewer: viewerId ? (post.likes || []).some((l) => l.userId === viewerId) : false,
    contextNoteCount: post._count?.contextNotes ?? 0,
    feedReason: reason,
    scoreBreakdown: breakdown,
  };
}

// Create a text thread ("twit") or a media post
router.post("/", requireAuth, upload.single("media"), async (req, res) => {
  const { body, groupId, audience, circleId, isAiGenerated, aiTool, category } = req.body || {};
  if (!body && !req.file) {
    return res.status(400).json({ error: "Write something or attach media before posting." });
  }

  let type = "TEXT";
  let mediaUrl = null;
  if (req.file) {
    mediaUrl = `/uploads/${req.file.filename}`;
    type = req.file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
  }

  const validAudiences = ["PUBLIC", "FRIENDS", "FOLLOWERS", "CIRCLE"];
  const resolvedAudience = validAudiences.includes(audience) ? audience : "PUBLIC";
  const validCategories = ["GENERAL", "SPORTS", "CELEBRITY", "NEWS"];
  const resolvedCategory = validCategories.includes(category) ? category : "GENERAL";

  const post = await prisma.post.create({
    data: {
      authorId: req.userId,
      body: body || null,
      mediaUrl,
      type,
      groupId: groupId || null,
      audience: resolvedAudience,
      circleId: resolvedAudience === "CIRCLE" ? circleId || null : null,
      isAiGenerated: isAiGenerated === "true" || isAiGenerated === true,
      aiTool: aiTool || null,
      category: resolvedCategory,
    },
    include: { author: { select: postAuthorSelect } },
  });
  res.status(201).json({ post: serialize({ post, score: 0, breakdown: {}, reason: "Your post" }, req.userId) });
});

// Platform-wide, public-only feed filtered by category -- powers the
// Sports, Celebrity, and News tabs, which are meant to surface public
// conversation across everyone, not just people you follow.
router.get("/explore", optionalAuth, async (req, res) => {
  const category = req.query.category;
  const validCategories = ["GENERAL", "SPORTS", "CELEBRITY", "NEWS"];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: "Provide a valid category: GENERAL, SPORTS, CELEBRITY, or NEWS." });
  }

  const posts = await prisma.post.findMany({
    where: { audience: "PUBLIC", groupId: null, category },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      author: { select: postAuthorSelect },
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true, contextNotes: true } },
    },
  });
  res.json({ posts: posts.map((p) => serialize({ post: p, score: 0, breakdown: {}, reason: "Public post" }, req.userId)) });
});

// Home feed: audience-filtered, weighted by the viewer's own algorithm settings
router.get("/feed", requireAuth, async (req, res) => {
  const [viewer, following, friendRows, myCircleMemberships] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId } }),
    prisma.follow.findMany({ where: { followerId: req.userId }, select: { followingId: true } }),
    prisma.friendRequest.findMany({
      where: { status: "ACCEPTED", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    }),
    prisma.circleMember.findMany({ where: { userId: req.userId }, select: { circleId: true } }),
  ]);

  const followingIds = new Set(following.map((f) => f.followingId));
  const friendIds = new Set(friendRows.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId)));
  const circleIds = myCircleMemberships.map((m) => m.circleId);

  // The old version wrapped everything in `authorId: { in: visibleAuthorIds }`,
  // which meant a PUBLIC post from someone you don't follow could never
  // appear -- so a new user's posts were invisible to everyone, and a new
  // user saw an empty feed. That defeats the point of marking a post public.
  // Now each audience level is self-contained: PUBLIC really means public,
  // and the restricted levels still check the relationship.
  const candidates = await prisma.post.findMany({
    where: {
      groupId: null,
      OR: [
        { audience: "PUBLIC" },
        { audience: "FOLLOWERS", authorId: { in: [...followingIds] } },
        { audience: "FRIENDS", authorId: { in: [...friendIds] } },
        { audience: "CIRCLE", circleId: { in: circleIds } },
        { authorId: req.userId }, // always see your own, whatever the audience
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      author: { select: postAuthorSelect },
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true, contextNotes: true } },
    },
  });

  const weights = viewer.feedWeights || { recency: 0.5, engagement: 0.3, diversity: 0.2 };
  const ranked = scoreAndRank(candidates, weights, req.userId, friendIds, followingIds).slice(0, 50);
  res.json({ posts: ranked.map((entry) => serialize(entry, req.userId)), feedWeights: weights });
});

// Public profile timeline (audience rules still apply if the viewer isn't the author)
router.get("/by/:username", optionalAuth, async (req, res) => {
  const author = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!author) return res.status(404).json({ error: "That user doesn't exist." });

  const isOwner = req.userId === author.id;
  const posts = await prisma.post.findMany({
    where: { authorId: author.id, groupId: null, ...(isOwner ? {} : { audience: "PUBLIC" }) },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      author: { select: postAuthorSelect },
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true, contextNotes: true } },
    },
  });
  res.json({ posts: posts.map((p) => serialize({ post: p, score: 0, breakdown: {}, reason: "" }, req.userId)) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!post || post.authorId !== req.userId) return res.status(404).json({ error: "Post not found." });
  await prisma.post.delete({ where: { id: post.id } });
  res.status(204).end();
});

// --- Public edit history: editing a post snapshots the previous body first,
// so nothing changes silently. GET /:id/history returns every version.
router.patch("/:id", requireAuth, async (req, res) => {
  const { body } = req.body || {};
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!post || post.authorId !== req.userId) return res.status(404).json({ error: "Post not found." });
  if (!body || !body.trim()) return res.status(400).json({ error: "A post can't be edited to be empty." });

  const [, updated] = await prisma.$transaction([
    prisma.postRevision.create({ data: { postId: post.id, body: post.body } }),
    prisma.post.update({ where: { id: post.id }, data: { body, editedAt: new Date() } }),
  ]);
  res.json({ post: updated });
});

router.get("/:id/history", async (req, res) => {
  const revisions = await prisma.postRevision.findMany({
    where: { postId: req.params.id },
    orderBy: { editedAt: "asc" },
  });
  res.json({ revisions });
});

router.post("/:id/like", requireAuth, async (req, res) => {
  await prisma.like.upsert({
    where: { postId_userId: { postId: req.params.id, userId: req.userId } },
    update: {},
    create: { postId: req.params.id, userId: req.userId },
  });
  res.status(201).end();
});

router.delete("/:id/like", requireAuth, async (req, res) => {
  await prisma.like.deleteMany({ where: { postId: req.params.id, userId: req.userId } });
  res.status(204).end();
});

router.get("/:id/comments", async (req, res) => {
  const comments = await prisma.comment.findMany({
    where: { postId: req.params.id },
    orderBy: { createdAt: "asc" },
    include: { author: { select: postAuthorSelect } },
  });
  res.json({ comments });
});

router.post("/:id/comments", requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "Comment can't be empty." });

  const comment = await prisma.comment.create({
    data: { postId: req.params.id, authorId: req.userId, body },
    include: { author: { select: postAuthorSelect } },
  });
  res.status(201).json({ comment });
});

// --- Crowd-sourced context notes: anyone can propose context on any post;
// anyone can vote it helpful/not. There's no per-platform gate -- notes are
// visible with their vote tally so readers judge credibility themselves.
router.get("/:id/notes", optionalAuth, async (req, res) => {
  const notes = await prisma.contextNote.findMany({
    where: { postId: req.params.id },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: postAuthorSelect },
      votes: true,
    },
  });
  const withTally = notes.map((n) => ({
    id: n.id,
    body: n.body,
    author: n.author,
    createdAt: n.createdAt,
    helpfulCount: n.votes.filter((v) => v.value === 1).length,
    notHelpfulCount: n.votes.filter((v) => v.value === -1).length,
    viewerVote: req.userId ? n.votes.find((v) => v.userId === req.userId)?.value ?? null : null,
  }));
  res.json({ notes: withTally });
});

router.post("/:id/notes", requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "Write the context before submitting." });

  const note = await prisma.contextNote.create({
    data: { postId: req.params.id, authorId: req.userId, body },
    include: { author: { select: postAuthorSelect } },
  });
  res.status(201).json({ note });
});

router.post("/notes/:noteId/vote", requireAuth, async (req, res) => {
  const { value } = req.body || {};
  if (![1, -1].includes(Number(value))) return res.status(400).json({ error: "Vote must be helpful or not helpful." });

  await prisma.noteVote.upsert({
    where: { noteId_userId: { noteId: req.params.noteId, userId: req.userId } },
    update: { value: Number(value) },
    create: { noteId: req.params.noteId, userId: req.userId, value: Number(value) },
  });
  res.status(201).end();
});

module.exports = router;
