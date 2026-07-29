const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();
const hostSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

router.get("/", optionalAuth, async (_req, res) => {
  const streams = await prisma.livestream.findMany({
    where: { status: "LIVE" },
    orderBy: { startedAt: "desc" },
    include: { host: hostSelect },
  });
  res.json({ streams });
});

router.post("/", requireAuth, async (req, res) => {
  const { title } = req.body || {};
  const existing = await prisma.livestream.findFirst({ where: { hostId: req.userId, status: "LIVE" } });
  if (existing) return res.status(409).json({ error: "You already have a stream live. End it before starting another." });

  const stream = await prisma.livestream.create({
    data: { hostId: req.userId, title: title || "Untitled stream" },
    include: { host: hostSelect },
  });
  res.status(201).json({ stream });
});

router.post("/:id/end", requireAuth, async (req, res) => {
  const stream = await prisma.livestream.findUnique({ where: { id: req.params.id } });
  if (!stream || stream.hostId !== req.userId) return res.status(404).json({ error: "Stream not found." });

  const updated = await prisma.livestream.update({
    where: { id: stream.id },
    data: { status: "ENDED", endedAt: new Date() },
  });
  res.json({ stream: updated });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const stream = await prisma.livestream.findUnique({
    where: { id: req.params.id },
    include: { host: hostSelect },
  });
  if (!stream) return res.status(404).json({ error: "Stream not found." });
  res.json({ stream });
});

module.exports = router;
