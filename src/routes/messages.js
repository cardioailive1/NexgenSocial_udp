const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `msg-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ""}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Only photos and videos can be attached to a message."));
  },
});

const userSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };
const mediaKind = (f) => (f.mimetype.startsWith("video") ? "VIDEO" : "PHOTO");

// Finds the existing 1:1 conversation between two people, or creates one.
// Doing this server-side avoids the classic bug where two people message
// each other simultaneously and end up in two separate threads.
async function findOrCreateDirect(userAId, userBId) {
  const existing = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: userAId } } },
        { participants: { some: { userId: userBId } } },
      ],
    },
    include: { participants: { include: { user: userSelect } } },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId: userAId }, { userId: userBId }] },
    },
    include: { participants: { include: { user: userSelect } } },
  });
}

// --- Conversations -------------------------------------------------------

router.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.conversationParticipant.findMany({
    where: { userId: req.userId },
    include: {
      conversation: {
        include: {
          participants: { include: { user: userSelect } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, include: { attachments: true } },
        },
      },
    },
  });

  const conversations = await Promise.all(rows.map(async (row) => {
    const convo = row.conversation;
    const other = convo.participants.find((p) => p.userId !== req.userId)?.user || null;
    const unread = await prisma.message.count({
      where: {
        conversationId: convo.id,
        senderId: { not: req.userId },
        ...(row.lastReadAt && { createdAt: { gt: row.lastReadAt } }),
      },
    });
    return {
      id: convo.id,
      isGroup: convo.isGroup,
      title: convo.title,
      otherUser: other,
      lastMessage: convo.messages[0] || null,
      lastMessageAt: convo.lastMessageAt,
      unreadCount: unread,
    };
  }));

  conversations.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  res.json({ conversations });
});

// Open (or start) a conversation with a specific person.
router.post("/with/:username", requireAuth, async (req, res) => {
  const other = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!other) return res.status(404).json({ error: "That user doesn't exist." });
  if (other.id === req.userId) return res.status(400).json({ error: "You can't message yourself." });

  const convo = await findOrCreateDirect(req.userId, other.id);
  res.json({
    conversation: {
      id: convo.id,
      isGroup: convo.isGroup,
      otherUser: convo.participants.find((p) => p.userId !== req.userId)?.user || null,
    },
  });
});

router.get("/:id/messages", requireAuth, async (req, res) => {
  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.userId },
  });
  if (!membership) return res.status(404).json({ error: "Conversation not found." });

  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { sender: userSelect, attachments: true },
  });

  // Opening the thread marks it read.
  await prisma.conversationParticipant.update({
    where: { id: membership.id },
    data: { lastReadAt: new Date() },
  });

  res.json({ messages });
});

router.post("/:id/messages", requireAuth, upload.array("media", 10), async (req, res) => {
  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.userId },
  });
  if (!membership) return res.status(404).json({ error: "Conversation not found." });

  const { body } = req.body || {};
  const files = req.files || [];
  if ((!body || !body.trim()) && files.length === 0) {
    return res.status(400).json({ error: "Write something or attach a file." });
  }

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: req.params.id,
        senderId: req.userId,
        body: body || null,
        attachments: {
          create: files.map((f, i) => ({ url: `/uploads/${f.filename}`, kind: mediaKind(f), position: i })),
        },
      },
      include: { sender: userSelect, attachments: true },
    }),
    // Keeps the conversation list ordered by real activity.
    prisma.conversation.update({
      where: { id: req.params.id },
      data: { lastMessageAt: new Date() },
    }),
  ]);

  res.status(201).json({ message });
});

router.delete("/messages/:messageId", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { id: req.params.messageId } });
  if (!message || message.senderId !== req.userId) return res.status(404).json({ error: "Message not found." });
  await prisma.message.delete({ where: { id: message.id } });
  res.status(204).end();
});

// Total unread across all conversations -- drives the navbar badge.
router.get("/unread-count", requireAuth, async (req, res) => {
  const rows = await prisma.conversationParticipant.findMany({
    where: { userId: req.userId },
    select: { conversationId: true, lastReadAt: true },
  });
  let total = 0;
  for (const row of rows) {
    total += await prisma.message.count({
      where: {
        conversationId: row.conversationId,
        senderId: { not: req.userId },
        ...(row.lastReadAt && { createdAt: { gt: row.lastReadAt } }),
      },
    });
  }
  res.json({ unreadCount: total });
});

// --- Calls (in-app, between NexgenSocial users) --------------------------
//
// These records track call state so the callee can be notified and both
// sides see a history. The actual audio runs over the existing WebRTC/
// mediasoup infrastructure, using the call id as the room id.
//
// This does NOT dial telephone numbers. See README "Calling real phone
// numbers" for what that would require.

router.post("/calls", requireAuth, async (req, res) => {
  const { username, kind } = req.body || {};
  const callee = await prisma.user.findUnique({ where: { username } });
  if (!callee) return res.status(404).json({ error: "That user doesn't exist." });
  if (callee.id === req.userId) return res.status(400).json({ error: "You can't call yourself." });

  const convo = await findOrCreateDirect(req.userId, callee.id);

  const call = await prisma.call.create({
    data: {
      conversationId: convo.id,
      callerId: req.userId,
      calleeId: callee.id,
      kind: kind === "VIDEO" ? "VIDEO" : "AUDIO",
    },
    include: { caller: userSelect, callee: userSelect },
  });
  res.status(201).json({ call });
});

// Polled by the client so an incoming call can be surfaced. A WebSocket
// push would be lower-latency; polling is used here because it works
// without holding a connection open per user, which matters on a single
// small instance.
router.get("/calls/incoming", requireAuth, async (req, res) => {
  const call = await prisma.call.findFirst({
    where: {
      calleeId: req.userId,
      status: "RINGING",
      // 2 minutes rather than 60s: browsers throttle timers in background
      // tabs, so a callee whose tab isn't focused can easily miss a
      // shorter window entirely and never see the call at all.
      startedAt: { gte: new Date(Date.now() - 120000) },
    },
    orderBy: { startedAt: "desc" },
    include: { caller: userSelect },
  });
  res.json({ call: call || null });
});

router.patch("/calls/:id", requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["ACTIVE", "ENDED", "MISSED", "DECLINED"].includes(status)) {
    return res.status(400).json({ error: "Invalid call status." });
  }

  const call = await prisma.call.findUnique({ where: { id: req.params.id } });
  if (!call || (call.callerId !== req.userId && call.calleeId !== req.userId)) {
    return res.status(404).json({ error: "Call not found." });
  }

  const updated = await prisma.call.update({
    where: { id: call.id },
    data: {
      status,
      ...(status === "ACTIVE" && { answeredAt: new Date() }),
      ...(["ENDED", "MISSED", "DECLINED"].includes(status) && { endedAt: new Date() }),
    },
    include: { caller: userSelect, callee: userSelect },
  });
  res.json({ call: updated });
});

router.get("/calls/:id/details", requireAuth, async (req, res) => {
  const call = await prisma.call.findUnique({
    where: { id: req.params.id },
    include: { caller: userSelect, callee: userSelect },
  });
  if (!call) return res.status(404).json({ error: "Call not found." });
  if (call.callerId !== req.userId && call.calleeId !== req.userId) {
    return res.status(403).json({ error: "You're not part of this call." });
  }
  res.json({ call });
});

router.get("/calls/history", requireAuth, async (req, res) => {
  const calls = await prisma.call.findMany({
    where: { OR: [{ callerId: req.userId }, { calleeId: req.userId }] },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: { caller: userSelect, callee: userSelect },
  });
  res.json({ calls });
});

module.exports = router;
