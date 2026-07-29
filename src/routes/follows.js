const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/:username", requireAuth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!target) return res.status(404).json({ error: "That user doesn't exist." });
  if (target.id === req.userId) return res.status(400).json({ error: "You can't follow yourself." });

  const follow = await prisma.follow.upsert({
    where: { followerId_followingId: { followerId: req.userId, followingId: target.id } },
    update: {},
    create: { followerId: req.userId, followingId: target.id },
  });
  res.status(201).json({ follow });
});

router.delete("/:username", requireAuth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!target) return res.status(404).json({ error: "That user doesn't exist." });

  await prisma.follow.deleteMany({ where: { followerId: req.userId, followingId: target.id } });
  res.status(204).end();
});

router.get("/:username/followers", async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!target) return res.status(404).json({ error: "That user doesn't exist." });

  const followers = await prisma.follow.findMany({
    where: { followingId: target.id },
    include: { follower: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  res.json({ followers: followers.map((f) => f.follower) });
});

router.get("/:username/following", async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!target) return res.status(404).json({ error: "That user doesn't exist." });

  const following = await prisma.follow.findMany({
    where: { followerId: target.id },
    include: { following: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  res.json({ following: following.map((f) => f.following) });
});

module.exports = router;
