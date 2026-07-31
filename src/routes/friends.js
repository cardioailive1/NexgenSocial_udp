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

// Cancel a pending request you sent. Declared before the "/:userId" route
// below, because Express matches in order and "/:userId" would otherwise
// capture "requests" as a user id and this would never be reached.
router.delete("/requests/:id", requireAuth, async (req, res) => {
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.senderId !== req.userId) {
    return res.status(404).json({ error: "No such request." });
  }
  if (request.status !== "PENDING") {
    return res.status(409).json({ error: "That request has already been answered." });
  }
  await prisma.friendRequest.delete({ where: { id: request.id } });
  res.status(204).end();
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
  const userSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

  // Previously this returned only INCOMING requests and accepted friends,
  // which meant that after you sent a request it disappeared from your view
  // entirely -- you'd see "Request sent" once and then have no way to check
  // whether it was still pending, or to take it back. Outgoing requests are
  // now returned as well.
  const [incoming, sent, accepted] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { receiverId: req.userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { sender: userSelect },
    }),
    prisma.friendRequest.findMany({
      where: { senderId: req.userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { receiver: userSelect },
    }),
    prisma.friendRequest.findMany({
      where: { status: "ACCEPTED", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
      include: { sender: userSelect, receiver: userSelect },
    }),
  ]);

  const friends = accepted.map((r) => (r.senderId === req.userId ? r.receiver : r.sender));
  res.json({ incomingRequests: incoming, sentRequests: sent, friends });
});

module.exports = router;
