const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();
const memberSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

router.post("/", requireAuth, async (req, res) => {
  const { name, description, isPrivate } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Give the group a name." });

  const group = await prisma.group.create({
    data: {
      name,
      description: description || null,
      isPrivate: !!isPrivate,
      ownerId: req.userId,
      members: { create: { userId: req.userId, role: "ADMIN" } },
    },
  });
  res.status(201).json({ group });
});

router.get("/", optionalAuth, async (req, res) => {
  const groups = await prisma.group.findMany({
    where: { isPrivate: false },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { owner: memberSelect, _count: { select: { members: true } } },
  });
  res.json({ groups });
});

router.get("/mine", requireAuth, async (req, res) => {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: req.userId },
    include: { group: { include: { _count: { select: { members: true } } } } },
  });
  res.json({ groups: memberships.map((m) => ({ ...m.group, myRole: m.role })) });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const group = await prisma.group.findUnique({
    where: { id: req.params.id },
    include: { owner: memberSelect, members: { include: { user: memberSelect } } },
  });
  if (!group) return res.status(404).json({ error: "Group not found." });
  res.json({ group });
});

router.post("/:id/join", requireAuth, async (req, res) => {
  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group) return res.status(404).json({ error: "Group not found." });
  if (group.isPrivate) return res.status(403).json({ error: "This group is invite-only." });

  const membership = await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: group.id, userId: req.userId } },
    update: {},
    create: { groupId: group.id, userId: req.userId },
  });
  res.status(201).json({ membership });
});

router.post("/:id/leave", requireAuth, async (req, res) => {
  await prisma.groupMember.deleteMany({ where: { groupId: req.params.id, userId: req.userId } });
  res.status(204).end();
});

router.get("/:id/posts", async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { groupId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: {
      author: memberSelect,
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true } },
    },
  });
  res.json({ posts });
});

module.exports = router;
