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

router.get("/:id/posts", optionalAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { groupId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: {
      author: memberSelect,
      likes: { select: { userId: true } },
      media: true,
      _count: { select: { likes: true, comments: true, contextNotes: true } },
    },
  });

  // Shaped to match what PostCard expects (likeCount, commentCount,
  // likedByViewer, media). Previously this returned raw Prisma rows, so
  // group posts rendered with missing counts and no attachments.
  res.json({
    posts: posts.map((p) => ({
      id: p.id,
      type: p.type,
      body: p.body,
      mediaUrl: p.mediaUrl,
      media: p.media || [],
      groupId: p.groupId,
      audience: p.audience,
      category: p.category,
      isAiGenerated: p.isAiGenerated,
      aiTool: p.aiTool,
      editedAt: p.editedAt,
      createdAt: p.createdAt,
      author: p.author,
      likeCount: p._count.likes,
      commentCount: p._count.comments,
      contextNoteCount: p._count.contextNotes,
      likedByViewer: req.userId ? p.likes.some((l) => l.userId === req.userId) : false,
    })),
  });
});

// Members list. The detail endpoint already includes members, but a
// dedicated route lets the UI page through a large group without
// re-fetching every post alongside it.
router.get("/:id/members", optionalAuth, async (req, res) => {
  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group) return res.status(404).json({ error: "Group not found." });

  const members = await prisma.groupMember.findMany({
    where: { groupId: group.id },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    include: { user: memberSelect },
  });

  res.json({
    members: members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      joinedAt: m.joinedAt,
      isOwner: m.userId === group.ownerId,
    })),
  });
});

module.exports = router;
