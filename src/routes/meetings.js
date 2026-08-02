const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `recording-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ".webm"}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

const userSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

// Short, unambiguous codes. Excludes characters people confuse when reading
// a code aloud or off a screen (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode() {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
}

// Loads the meeting and the caller's role in one go. Every host-only action
// goes through this rather than re-checking ownership ad hoc.
async function loadContext(meetingId, userId) {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting) return { error: "Meeting not found." };
  const seat = await prisma.meetingParticipant.findUnique({
    where: { meetingId_userId: { meetingId, userId } },
  });
  const isHost = meeting.hostId === userId;
  const isCohost = seat?.role === "COHOST";
  return { meeting, seat, isHost, canManage: isHost || isCohost };
}

// --- Create / list -------------------------------------------------------

router.post("/", requireAuth, async (req, res) => {
  const {
    title, description, scheduledFor,
    waitingRoomEnabled, muteOnEntry, allowParticipantScreenShare, allowChat,
    inviteUserIds, inviteGroupIds,
  } = req.body || {};

  if (!title || !title.trim()) return res.status(400).json({ error: "Give the meeting a title." });

  // Retry on the astronomically unlikely code collision rather than 500.
  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    const taken = await prisma.meeting.findUnique({ where: { code } });
    if (!taken) break;
    code = generateCode();
  }

  const meeting = await prisma.meeting.create({
    data: {
      hostId: req.userId,
      title,
      description: description || null,
      code,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      waitingRoomEnabled: waitingRoomEnabled !== false,
      muteOnEntry: muteOnEntry !== false,
      allowParticipantScreenShare: allowParticipantScreenShare !== false,
      allowChat: allowChat !== false,
      // The host has a seat from the outset, already admitted.
      participants: { create: { userId: req.userId, role: "HOST", admitted: true } },
      invites: {
        create: [
          ...(Array.isArray(inviteUserIds) ? inviteUserIds.map((userId) => ({ userId })) : []),
          ...(Array.isArray(inviteGroupIds) ? inviteGroupIds.map((groupId) => ({ groupId })) : []),
        ],
      },
    },
    include: { host: userSelect, invites: true },
  });

  res.status(201).json({ meeting });
});

// Meetings you host, were invited to directly, or can reach through a group.
router.get("/", requireAuth, async (req, res) => {
  const myGroups = await prisma.groupMember.findMany({
    where: { userId: req.userId },
    select: { groupId: true },
  });
  const groupIds = myGroups.map((g) => g.groupId);

  const meetings = await prisma.meeting.findMany({
    where: {
      status: { not: "ENDED" },
      OR: [
        { hostId: req.userId },
        { participants: { some: { userId: req.userId } } },
        { invites: { some: { userId: req.userId } } },
        { invites: { some: { groupId: { in: groupIds } } } },
      ],
    },
    orderBy: [{ status: "asc" }, { scheduledFor: "asc" }, { createdAt: "desc" }],
    include: {
      host: userSelect,
      _count: { select: { participants: true } },
    },
  });

  res.json({
    meetings: meetings.map((m) => ({
      id: m.id, title: m.title, description: m.description, code: m.code,
      status: m.status, scheduledFor: m.scheduledFor, startedAt: m.startedAt,
      host: m.host, participantCount: m._count.participants,
      isHost: m.hostId === req.userId,
    })),
  });
});

// Look up by join code, so someone can enter a code they were given.
router.get("/by-code/:code", requireAuth, async (req, res) => {
  const meeting = await prisma.meeting.findUnique({
    where: { code: req.params.code.toUpperCase() },
    include: { host: userSelect },
  });
  if (!meeting) return res.status(404).json({ error: "No meeting with that code." });
  res.json({ meeting: { id: meeting.id, title: meeting.title, host: meeting.host, status: meeting.status } });
});

router.get("/:id", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });

  const [participants, recordings] = await Promise.all([
    prisma.meetingParticipant.findMany({
      where: { meetingId: ctx.meeting.id, removed: false },
      include: { user: userSelect },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
    prisma.meetingRecording.findMany({
      where: { meetingId: ctx.meeting.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.json({
    meeting: ctx.meeting,
    isHost: ctx.isHost,
    canManage: ctx.canManage,
    mySeat: ctx.seat,
    participants: participants.map((p) => ({
      id: p.id, user: p.user, role: p.role, admitted: p.admitted,
      mutedByHost: p.mutedByHost, joinedAt: p.joinedAt,
    })),
    // Private recordings are only ever returned to someone who can manage
    // the meeting; published ones are visible to any participant.
    recordings: recordings.filter((r) => r.visibility === "PUBLIC" || ctx.canManage),
  });
});

// --- Joining -------------------------------------------------------------

router.post("/:id/join", requireAuth, async (req, res) => {
  const meeting = await prisma.meeting.findUnique({ where: { id: req.params.id } });
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });
  if (meeting.status === "ENDED") return res.status(409).json({ error: "This meeting has ended." });

  const existing = await prisma.meetingParticipant.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: req.userId } },
  });
  if (existing?.removed) {
    return res.status(403).json({ error: "You were removed from this meeting by the host." });
  }
  if (meeting.locked && !existing?.admitted && meeting.hostId !== req.userId) {
    return res.status(403).json({ error: "The host has locked this meeting." });
  }

  const isHost = meeting.hostId === req.userId;
  // Admitted straight away if you're the host, already admitted, or the
  // waiting room is off.
  const admitted = isHost || existing?.admitted || !meeting.waitingRoomEnabled;

  const seat = await prisma.meetingParticipant.upsert({
    where: { meetingId_userId: { meetingId: meeting.id, userId: req.userId } },
    update: { admitted, joinedAt: new Date(), leftAt: null },
    create: {
      meetingId: meeting.id,
      userId: req.userId,
      role: isHost ? "HOST" : "PARTICIPANT",
      admitted,
      mutedByHost: !isHost && meeting.muteOnEntry,
      joinedAt: new Date(),
    },
    include: { user: userSelect },
  });

  res.json({
    seat,
    waiting: !admitted,
    meeting: { id: meeting.id, title: meeting.title, allowChat: meeting.allowChat, muteOnEntry: meeting.muteOnEntry },
  });
});

router.post("/:id/leave", requireAuth, async (req, res) => {
  await prisma.meetingParticipant.updateMany({
    where: { meetingId: req.params.id, userId: req.userId },
    data: { leftAt: new Date() },
  });
  res.status(204).end();
});

// Polled by someone in the waiting room so they know when they're let in.
router.get("/:id/my-status", requireAuth, async (req, res) => {
  const seat = await prisma.meetingParticipant.findUnique({
    where: { meetingId_userId: { meetingId: req.params.id, userId: req.userId } },
  });
  if (!seat) return res.json({ admitted: false, removed: false, present: false });
  res.json({ admitted: seat.admitted, removed: seat.removed, mutedByHost: seat.mutedByHost, present: true });
});

// --- Host controls -------------------------------------------------------

router.post("/:id/start", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.isHost) return res.status(403).json({ error: "Only the host can start the meeting." });

  const meeting = await prisma.meeting.update({
    where: { id: ctx.meeting.id },
    data: { status: "LIVE", startedAt: ctx.meeting.startedAt || new Date() },
  });
  res.json({ meeting });
});

router.post("/:id/end", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.isHost) return res.status(403).json({ error: "Only the host can end the meeting." });

  const meeting = await prisma.meeting.update({
    where: { id: ctx.meeting.id },
    data: { status: "ENDED", endedAt: new Date() },
  });
  res.json({ meeting });
});

router.patch("/:id/settings", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.canManage) return res.status(403).json({ error: "Only the host can change meeting settings." });

  const { waitingRoomEnabled, muteOnEntry, allowParticipantScreenShare, allowChat, locked } = req.body || {};
  const meeting = await prisma.meeting.update({
    where: { id: ctx.meeting.id },
    data: {
      ...(waitingRoomEnabled !== undefined && { waitingRoomEnabled: !!waitingRoomEnabled }),
      ...(muteOnEntry !== undefined && { muteOnEntry: !!muteOnEntry }),
      ...(allowParticipantScreenShare !== undefined && { allowParticipantScreenShare: !!allowParticipantScreenShare }),
      ...(allowChat !== undefined && { allowChat: !!allowChat }),
      ...(locked !== undefined && { locked: !!locked }),
    },
  });
  res.json({ meeting });
});

router.post("/:id/participants/:participantId/admit", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.canManage) return res.status(403).json({ error: "Only the host can admit people." });

  const seat = await prisma.meetingParticipant.update({
    where: { id: req.params.participantId },
    data: { admitted: true },
    include: { user: userSelect },
  });
  res.json({ participant: seat });
});

router.post("/:id/participants/:participantId/mute", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.canManage) return res.status(403).json({ error: "Only the host can mute people." });

  const { muted } = req.body || {};
  const seat = await prisma.meetingParticipant.update({
    where: { id: req.params.participantId },
    data: { mutedByHost: muted !== false },
    include: { user: userSelect },
  });
  res.json({ participant: seat });
});

router.post("/:id/participants/:participantId/remove", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.canManage) return res.status(403).json({ error: "Only the host can remove people." });

  const target = await prisma.meetingParticipant.findUnique({ where: { id: req.params.participantId } });
  if (target?.userId === ctx.meeting.hostId) {
    return res.status(400).json({ error: "The host can't be removed from their own meeting." });
  }

  const seat = await prisma.meetingParticipant.update({
    where: { id: req.params.participantId },
    data: { removed: true, admitted: false, leftAt: new Date() },
  });
  res.json({ participant: seat });
});

router.post("/:id/participants/:participantId/role", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.isHost) return res.status(403).json({ error: "Only the host can change roles." });

  const { role } = req.body || {};
  if (!["COHOST", "PARTICIPANT"].includes(role)) {
    return res.status(400).json({ error: "Role must be COHOST or PARTICIPANT." });
  }
  const seat = await prisma.meetingParticipant.update({
    where: { id: req.params.participantId },
    data: { role },
    include: { user: userSelect },
  });
  res.json({ participant: seat });
});

// --- Invites -------------------------------------------------------------

router.post("/:id/invite", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.canManage) return res.status(403).json({ error: "Only the host can invite people." });

  const { userIds, groupIds } = req.body || {};
  const rows = [
    ...(Array.isArray(userIds) ? userIds.map((userId) => ({ meetingId: ctx.meeting.id, userId })) : []),
    ...(Array.isArray(groupIds) ? groupIds.map((groupId) => ({ meetingId: ctx.meeting.id, groupId })) : []),
  ];
  if (rows.length === 0) return res.status(400).json({ error: "Choose at least one person or group." });

  await prisma.meetingInvite.createMany({ data: rows, skipDuplicates: true });
  res.status(201).json({ invited: rows.length });
});

// --- Chat ----------------------------------------------------------------

router.get("/:id/chat", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });

  const messages = await prisma.meetingChatMessage.findMany({
    where: { meetingId: ctx.meeting.id },
    orderBy: { createdAt: "asc" },
    take: 300,
    include: { sender: userSelect },
  });
  res.json({ messages });
});

router.post("/:id/chat", requireAuth, async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  if (!ctx.meeting.allowChat && !ctx.canManage) {
    return res.status(403).json({ error: "The host has turned chat off." });
  }

  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "Write something first." });

  const message = await prisma.meetingChatMessage.create({
    data: { meetingId: ctx.meeting.id, senderId: req.userId, body },
    include: { sender: userSelect },
  });
  res.status(201).json({ message });
});

// --- Recordings ----------------------------------------------------------

router.post("/:id/recordings", requireAuth, upload.single("recording"), async (req, res) => {
  const ctx = await loadContext(req.params.id, req.userId);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  // Only the host can save a recording. Letting any participant upload one
  // would mean a meeting could be recorded and kept by someone the host
  // never authorised.
  if (!ctx.isHost) return res.status(403).json({ error: "Only the host can save a recording." });
  if (!req.file) return res.status(400).json({ error: "No recording file received." });

  const recording = await prisma.meetingRecording.create({
    data: {
      meetingId: ctx.meeting.id,
      url: `/uploads/${req.file.filename}`,
      durationSec: req.body.durationSec ? Number(req.body.durationSec) : null,
      sizeBytes: req.file.size,
      visibility: "PRIVATE", // always private until the host chooses otherwise
    },
  });
  res.status(201).json({ recording });
});

// Publish a recording as a public post.
router.post("/recordings/:recordingId/publish", requireAuth, async (req, res) => {
  const recording = await prisma.meetingRecording.findUnique({
    where: { id: req.params.recordingId },
    include: { meeting: true },
  });
  if (!recording) return res.status(404).json({ error: "Recording not found." });
  if (recording.meeting.hostId !== req.userId) {
    return res.status(403).json({ error: "Only the host can publish this recording." });
  }

  const { caption } = req.body || {};
  const post = await prisma.post.create({
    data: {
      authorId: req.userId,
      body: caption || `Recording: ${recording.meeting.title}`,
      type: "VIDEO",
      mediaUrl: recording.url,
      audience: "PUBLIC",
      media: { create: [{ url: recording.url, kind: "VIDEO", position: 0 }] },
    },
  });

  const updated = await prisma.meetingRecording.update({
    where: { id: recording.id },
    data: { visibility: "PUBLIC", postId: post.id },
  });
  res.json({ recording: updated, postId: post.id });
});

router.post("/recordings/:recordingId/unpublish", requireAuth, async (req, res) => {
  const recording = await prisma.meetingRecording.findUnique({
    where: { id: req.params.recordingId },
    include: { meeting: true },
  });
  if (!recording || recording.meeting.hostId !== req.userId) {
    return res.status(404).json({ error: "Recording not found." });
  }
  // Removes the public post as well -- unpublishing that left the post up
  // would be a nasty surprise.
  if (recording.postId) {
    await prisma.post.deleteMany({ where: { id: recording.postId } });
  }
  const updated = await prisma.meetingRecording.update({
    where: { id: recording.id },
    data: { visibility: "PRIVATE", postId: null },
  });
  res.json({ recording: updated });
});

router.delete("/recordings/:recordingId", requireAuth, async (req, res) => {
  const recording = await prisma.meetingRecording.findUnique({
    where: { id: req.params.recordingId },
    include: { meeting: true },
  });
  if (!recording || recording.meeting.hostId !== req.userId) {
    return res.status(404).json({ error: "Recording not found." });
  }
  if (recording.postId) await prisma.post.deleteMany({ where: { id: recording.postId } });
  await prisma.meetingRecording.delete({ where: { id: recording.id } });
  res.status(204).end();
});

module.exports = router;
