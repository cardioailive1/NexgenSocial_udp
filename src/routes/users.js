const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

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
