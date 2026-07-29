const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Send a friend invitation
router.post("/requests", requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "Username is required." });

  const receiver = await prisma.user.findUnique({ where: { username } });
  if (!receiver) return res.status(404).json({ error: "That user doesn't exist." });
  if (receiver.id === req.userId) return res.status(400).json({ error: "You can't friend yourself." });

  const existing = await prisma.friendRequest.findFirst({
    where: {
      OR: [
        { senderId: req.userId, receiverId: receiver.id },
        { senderId: receiver.id, receiverId: req.userId },
      ],
    },
  });
  if (existing) return res.status(409).json({ error: "A friend request already exists between you two." });

  const request = await prisma.friendRequest.create({
    data: { senderId: req.userId, receiverId: receiver.id },
  });
  res.status(201).json({ request });
});

// Accept or decline an invitation
router.patch("/requests/:id", requireAuth, async (req, res) => {
  const { action } = req.body || {}; // "accept" | "decline"
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.receiverId !== req.userId) {
    return res.status(404).json({ error: "No such invitation." });
  }
  if (request.status !== "PENDING") {
    return res.status(409).json({ error: "This invitation was already answered." });
  }

  const status = action === "accept" ? "ACCEPTED" : "DECLINED";
  const updated = await prisma.friendRequest.update({
    where: { id: request.id },
    data: { status, respondedAt: new Date() },
  });
  res.json({ request: updated });
});

// Remove an existing friendship
router.delete("/:userId", requireAuth, async (req, res) => {
  const otherId = req.params.userId;
  await prisma.friendRequest.deleteMany({
    where: {
      status: "ACCEPTED",
      OR: [
        { senderId: req.userId, receiverId: otherId },
        { senderId: otherId, receiverId: req.userId },
      ],
    },
  });
  res.status(204).end();
});

// List: pending invitations you've received, and your accepted friends
router.get("/", requireAuth, async (req, res) => {
  const [incoming, accepted] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { receiverId: req.userId, status: "PENDING" },
      include: { sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    }),
    prisma.friendRequest.findMany({
      where: { status: "ACCEPTED", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    }),
  ]);

  const friends = accepted.map((r) => (r.senderId === req.userId ? r.receiver : r.sender));
  res.json({ incomingRequests: incoming, friends });
});

module.exports = router;
