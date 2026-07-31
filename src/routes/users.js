const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

// Same local-disk pattern as post media uploads (see routes/posts.js for
// the same production caveat: this is ephemeral on hosts like Fly/Render
// and should move to S3-compatible storage before relying on it long-term).
const avatarStorage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (req, file, cb) => {
    const unique = `avatar-${req.userId}-${Date.now()}`;
    cb(null, `${unique}${path.extname(file.originalname) || ".jpg"}`);
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB is plenty for a profile photo
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Profile photo must be an image."));
    cb(null, true);
  },
});

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

router.get("/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ users: [] });

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
      ],
    },
    take: 20,
  });
  res.json({ users: users.map(publicUser) });
});

// Browse everyone on the platform. This didn't exist before -- there was
// only /search, which requires knowing a name to type, so a newly created
// account was effectively invisible to everyone. Returns relationship
// context per user so the UI can show the right action button without an
// extra request per row.
router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();

  const users = await prisma.user.findMany({
    where: {
      id: { not: req.userId },
      ...(q && {
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { displayName: { contains: q, mode: "insensitive" } },
        ],
      }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const ids = users.map((u) => u.id);
  const [following, friendRows] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: req.userId, followingId: { in: ids } },
      select: { followingId: true },
    }),
    prisma.friendRequest.findMany({
      where: {
        OR: [
          { senderId: req.userId, receiverId: { in: ids } },
          { receiverId: req.userId, senderId: { in: ids } },
        ],
      },
    }),
  ]);

  const followingSet = new Set(following.map((f) => f.followingId));
  const friendStatusById = new Map();
  for (const fr of friendRows) {
    const otherId = fr.senderId === req.userId ? fr.receiverId : fr.senderId;
    friendStatusById.set(otherId, {
      status: fr.status,
      // Needed so the UI knows whether to show "Accept" or "Request sent"
      incoming: fr.receiverId === req.userId,
      requestId: fr.id,
    });
  }

  res.json({
    users: users.map((u) => {
      const { passwordHash, ...safe } = u;
      const fr = friendStatusById.get(u.id);
      return {
        ...safe,
        isFollowing: followingSet.has(u.id),
        friendStatus: fr?.status || "NONE",
        friendRequestIncoming: fr?.incoming || false,
        friendRequestId: fr?.requestId || null,
      };
    }),
  });
});

router.get("/:username", optionalAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!user) return res.status(404).json({ error: "That profile doesn't exist." });

  const [followerCount, followingCount, friendCount] = await Promise.all([
    prisma.follow.count({ where: { followingId: user.id } }),
    prisma.follow.count({ where: { followerId: user.id } }),
    prisma.friendRequest.count({
      where: { status: "ACCEPTED", OR: [{ senderId: user.id }, { receiverId: user.id }] },
    }),
  ]);

  let viewerContext = null;
  if (req.userId && req.userId !== user.id) {
    const [isFollowing, friendReq] = await Promise.all([
      prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: req.userId, followingId: user.id } },
      }),
      prisma.friendRequest.findFirst({
        where: {
          OR: [
            { senderId: req.userId, receiverId: user.id },
            { senderId: user.id, receiverId: req.userId },
          ],
        },
      }),
    ]);
    viewerContext = {
      isFollowing: !!isFollowing,
      friendStatus: friendReq ? friendReq.status : "NONE",
    };
  }

  res.json({
    user: publicUser(user),
    stats: { followerCount, followingCount, friendCount },
    viewerContext,
  });
});

router.post("/me/avatar", requireAuth, uploadAvatar.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file was received." });

  const avatarUrl = `/uploads/${req.file.filename}`;
  const user = await prisma.user.update({ where: { id: req.userId }, data: { avatarUrl } });
  res.status(201).json({ user: publicUser(user) });
});

router.patch("/me", requireAuth, async (req, res) => {
  const { displayName, bio, avatarUrl, coverUrl } = req.body || {};
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: {
      ...(displayName !== undefined && { displayName }),
      ...(bio !== undefined && { bio }),
      ...(avatarUrl !== undefined && { avatarUrl }),
      ...(coverUrl !== undefined && { coverUrl }),
    },
  });
  res.json({ user: publicUser(user) });
});

// --- Adjustable feed algorithm: the person sets their own weighting instead
// of a black-box ranking. Used by GET /api/posts/feed to score & order posts.
router.get("/me/feed-weights", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  res.json({ feedWeights: user.feedWeights });
});

router.patch("/me/feed-weights", requireAuth, async (req, res) => {
  const { recency, engagement, diversity } = req.body || {};
  const clamp = (n) => Math.max(0, Math.min(1, Number(n)));
  if ([recency, engagement, diversity].some((v) => v === undefined || Number.isNaN(Number(v)))) {
    return res.status(400).json({ error: "Provide recency, engagement, and diversity as numbers between 0 and 1." });
  }
  const feedWeights = { recency: clamp(recency), engagement: clamp(engagement), diversity: clamp(diversity) };
  const user = await prisma.user.update({ where: { id: req.userId }, data: { feedWeights } });
  res.json({ feedWeights: user.feedWeights });
});

// --- One-click full data export (own everything you've posted, no
// gatekeeping, no support ticket required). Returns everything tied to the
// account as a single JSON document.
router.get("/me/export", requireAuth, async (req, res) => {
  const [user, posts, comments, likes, sentRequests, receivedRequests, following, followers, groupMemberships, socialAccounts, invites] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId } }),
      prisma.post.findMany({ where: { authorId: req.userId }, include: { revisions: true } }),
      prisma.comment.findMany({ where: { authorId: req.userId } }),
      prisma.like.findMany({ where: { userId: req.userId } }),
      prisma.friendRequest.findMany({ where: { senderId: req.userId } }),
      prisma.friendRequest.findMany({ where: { receiverId: req.userId } }),
      prisma.follow.findMany({ where: { followerId: req.userId } }),
      prisma.follow.findMany({ where: { followingId: req.userId } }),
      prisma.groupMember.findMany({ where: { userId: req.userId }, include: { group: true } }),
      prisma.socialAccount.findMany({ where: { userId: req.userId } }),
      prisma.invite.findMany({ where: { senderId: req.userId } }),
    ]);

  res.setHeader("Content-Disposition", `attachment; filename="nexgensocial-export-${user.username}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    profile: publicUser(user),
    posts,
    comments,
    likes,
    friendRequestsSent: sentRequests,
    friendRequestsReceived: receivedRequests,
    following,
    followers,
    groupMemberships,
    linkedAccounts: socialAccounts,
    invitesSent: invites,
  });
});

module.exports = router;
