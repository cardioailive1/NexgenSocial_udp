const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const memberSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

router.get("/", requireAuth, async (req, res) => {
  const circles = await prisma.circle.findMany({
    where: { ownerId: req.userId },
    include: { members: { include: { user: memberSelect } } },
  });
  res.json({ circles });
});

router.post("/", requireAuth, async (req, res) => {
  const { name, memberUsernames } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Give the circle a name." });

  const members = Array.isArray(memberUsernames) ? memberUsernames : [];
  const users = members.length
    ? await prisma.user.findMany({ where: { username: { in: members } } })
    : [];

  const circle = await prisma.circle.create({
    data: {
      name,
      ownerId: req.userId,
      members: { create: users.map((u) => ({ userId: u.id })) },
    },
    include: { members: { include: { user: memberSelect } } },
  });
  res.status(201).json({ circle });
});

router.post("/:id/members", requireAuth, async (req, res) => {
  const { username } = req.body || {};
  const circle = await prisma.circle.findUnique({ where: { id: req.params.id } });
  if (!circle || circle.ownerId !== req.userId) return res.status(404).json({ error: "Circle not found." });

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(404).json({ error: "That user doesn't exist." });

  await prisma.circleMember.upsert({
    where: { circleId_userId: { circleId: circle.id, userId: user.id } },
    update: {},
    create: { circleId: circle.id, userId: user.id },
  });
  res.status(201).end();
});

router.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const circle = await prisma.circle.findUnique({ where: { id: req.params.id } });
  if (!circle || circle.ownerId !== req.userId) return res.status(404).json({ error: "Circle not found." });

  await prisma.circleMember.deleteMany({ where: { circleId: circle.id, userId: req.params.userId } });
  res.status(204).end();
});

router.delete("/:id", requireAuth, async (req, res) => {
  const circle = await prisma.circle.findUnique({ where: { id: req.params.id } });
  if (!circle || circle.ownerId !== req.userId) return res.status(404).json({ error: "Circle not found." });

  await prisma.circle.delete({ where: { id: circle.id } });
  res.status(204).end();
});

module.exports = router;
