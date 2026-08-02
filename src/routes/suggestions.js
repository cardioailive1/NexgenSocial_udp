const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const userSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, occupation: true, city: true } };

// --- Profile completeness -------------------------------------------------
// Weighted so the fields that actually improve someone's experience count
// for more. A photo and a bio are what make a profile recognisable to
// others; a birth date mostly helps ad targeting, which is opt-in anyway,
// so it's worth less here.
const PROFILE_CHECKS = [
  { key: "avatarUrl",   weight: 25, label: "Add a profile photo",       action: "/profile-setup", hint: "People are far more likely to accept a request from a profile with a photo." },
  { key: "bio",         weight: 15, label: "Write a short bio",         action: "/profile-setup", hint: "A sentence or two about you." },
  { key: "city",        weight: 10, label: "Add your location",         action: "/profile-setup", hint: "Helps you find people and groups nearby." },
  { key: "occupation",  weight: 10, label: "Add what you do",           action: "/profile-setup", hint: "Useful if you plan to use the jobs board." },
  { key: "birthDate",   weight: 10, label: "Add your birth date",       action: "/profile-setup", hint: "Kept private unless you choose otherwise." },
];

router.get("/profile-status", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: {
      interests: { select: { id: true } },
      _count: { select: { posts: true } },
    },
  });
  if (!user) return res.status(404).json({ error: "Account not found." });

  const missing = [];
  let score = 0;

  for (const check of PROFILE_CHECKS) {
    if (user[check.key]) score += check.weight;
    else missing.push({ key: check.key, label: check.label, action: check.action, hint: check.hint });
  }

  // Interests and a first post are separate from the simple field checks.
  if (user.interests.length > 0) score += 20;
  else missing.push({
    key: "interests", label: "Pick a few interests", action: "/profile-setup",
    hint: "Used to suggest people and content you'll actually care about.",
  });

  if (user._count.posts > 0) score += 10;
  else missing.push({
    key: "firstPost", label: "Write your first post", action: "/",
    hint: "Profiles with a post get noticeably more follows.",
  });

  const [followingCount, friendCount] = await Promise.all([
    prisma.follow.count({ where: { followerId: req.userId } }),
    prisma.friendRequest.count({
      where: { status: "ACCEPTED", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    }),
  ]);

  if (followingCount === 0 && friendCount === 0) {
    missing.push({
      key: "connections", label: "Follow a few people", action: "/people",
      hint: "Your feed stays empty until you follow someone.",
    });
  }

  res.json({
    completeness: Math.min(100, score),
    missing,
    // A profile is "complete enough" once the high-value items are done --
    // nagging someone who has a photo, a bio and interests is just noise.
    isComplete: missing.filter((m) => ["avatarUrl", "bio", "interests"].includes(m.key)).length === 0,
  });
});

// --- Friend suggestions ---------------------------------------------------
//
// Ranked by signals that actually predict a real connection, strongest
// first: people you already share friends with, then shared interests,
// then same city. Random "people you may know" lists are noise; these at
// least have a reason attached, which is also what makes the suggestion
// explainable to the person seeing it.
router.get("/friends", requireAuth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { interests: { select: { interestId: true } } },
  });
  if (!me) return res.status(404).json({ error: "Account not found." });

  const myInterestIds = me.interests.map((i) => i.interestId);

  // Everyone already connected to, in any direction -- excluded from
  // suggestions so we never suggest someone you've already asked.
  const [following, friendRows, pendingRows] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: req.userId }, select: { followingId: true } }),
    prisma.friendRequest.findMany({
      where: { status: "ACCEPTED", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    }),
    prisma.friendRequest.findMany({
      where: { status: "PENDING", OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    }),
  ]);

  const friendIds = friendRows.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId));
  const excluded = new Set([
    req.userId,
    ...following.map((f) => f.followingId),
    ...friendIds,
    ...pendingRows.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId)),
  ]);

  // Friends-of-friends, which is the strongest available signal.
  const secondDegree = friendIds.length
    ? await prisma.friendRequest.findMany({
        where: { status: "ACCEPTED", OR: [{ senderId: { in: friendIds } }, { receiverId: { in: friendIds } }] },
      })
    : [];

  const mutualCount = new Map();
  for (const row of secondDegree) {
    for (const candidateId of [row.senderId, row.receiverId]) {
      if (excluded.has(candidateId) || friendIds.includes(candidateId)) continue;
      mutualCount.set(candidateId, (mutualCount.get(candidateId) || 0) + 1);
    }
  }

  const candidates = await prisma.user.findMany({
    where: { id: { notIn: [...excluded] } },
    include: { interests: { select: { interestId: true } } },
    take: 200,
  });

  const scored = candidates.map((u) => {
    const mutuals = mutualCount.get(u.id) || 0;
    const sharedInterests = u.interests.filter((i) => myInterestIds.includes(i.interestId)).length;
    const sameCity = me.city && u.city && me.city.toLowerCase() === u.city.toLowerCase();

    const score = mutuals * 10 + sharedInterests * 3 + (sameCity ? 4 : 0);

    // Every suggestion carries its reason. A suggestion you can't explain
    // is one people reasonably distrust.
    let reason;
    if (mutuals > 0) reason = `${mutuals} mutual friend${mutuals === 1 ? "" : "s"}`;
    else if (sharedInterests > 0) reason = `${sharedInterests} shared interest${sharedInterests === 1 ? "" : "s"}`;
    else if (sameCity) reason = `Also in ${u.city}`;
    else reason = "New on NexgenSocial";

    const { passwordHash, interests, ...safe } = u;
    return { user: safe, score, reason, mutuals, sharedInterests };
  });

  scored.sort((a, b) => b.score - a.score);

  res.json({
    suggestions: scored.slice(0, 12).map((s) => ({
      id: s.user.id,
      username: s.user.username,
      displayName: s.user.displayName,
      avatarUrl: s.user.avatarUrl,
      bio: s.user.bio,
      occupation: s.user.occupation,
      city: s.user.city,
      reason: s.reason,
      mutuals: s.mutuals,
    })),
  });
});

module.exports = router;
