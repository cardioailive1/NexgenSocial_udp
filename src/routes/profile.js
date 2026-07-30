const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const RELATIONSHIP_STATUSES = [
  "SINGLE", "IN_RELATIONSHIP", "ENGAGED", "MARRIED", "DOMESTIC_PARTNERSHIP",
  "SEPARATED", "DIVORCED", "WIDOWED", "PREFER_NOT_TO_SAY",
];

// Ensures a PrivacySettings row exists for a user. Called lazily rather
// than at signup so existing accounts get one on first access too.
async function ensurePrivacySettings(userId) {
  return prisma.privacySettings.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

// --- Extended profile ---

router.get("/me", requireAuth, async (req, res) => {
  const [user, privacy] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.userId },
      include: { interests: { include: { interest: true } } },
    }),
    ensurePrivacySettings(req.userId),
  ]);
  if (!user) return res.status(404).json({ error: "Account not found." });

  const { passwordHash, ...safe } = user;
  res.json({
    profile: {
      ...safe,
      interests: user.interests.map((ui) => ui.interest),
    },
    privacySettings: privacy,
  });
});

router.patch("/me", requireAuth, async (req, res) => {
  const {
    birthDate, gender, relationshipStatus, occupation, education,
    city, country, timezone, hasChildren, bio,
  } = req.body || {};

  if (relationshipStatus && !RELATIONSHIP_STATUSES.includes(relationshipStatus)) {
    return res.status(400).json({ error: "That relationship status isn't a valid option." });
  }

  let parsedBirthDate;
  if (birthDate !== undefined) {
    if (birthDate === null || birthDate === "") {
      parsedBirthDate = null;
    } else {
      const d = new Date(birthDate);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "That birth date isn't a valid date." });
      // Sanity bounds: rejects both obvious typos and under-13 signups
      // (COPPA makes under-13 data collection a genuinely different legal
      // regime, so it's safer to block than to quietly accept).
      const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (age < 13) return res.status(400).json({ error: "You must be at least 13 to use NexgenSocial." });
      if (age > 120) return res.status(400).json({ error: "Please check that birth date." });
      parsedBirthDate = d;
    }
  }

  const user = await prisma.user.update({
    where: { id: req.userId },
    data: {
      ...(parsedBirthDate !== undefined && { birthDate: parsedBirthDate }),
      ...(gender !== undefined && { gender: gender || null }),
      ...(relationshipStatus !== undefined && { relationshipStatus: relationshipStatus || null }),
      ...(occupation !== undefined && { occupation: occupation || null }),
      ...(education !== undefined && { education: education || null }),
      ...(city !== undefined && { city: city || null }),
      ...(country !== undefined && { country: country || null }),
      ...(timezone !== undefined && { timezone: timezone || null }),
      ...(hasChildren !== undefined && { hasChildren }),
      ...(bio !== undefined && { bio: bio || null }),
    },
  });

  const { passwordHash, ...safe } = user;
  res.json({ profile: safe });
});

// --- Privacy / consent settings ---

router.get("/me/privacy", requireAuth, async (req, res) => {
  res.json({ privacySettings: await ensurePrivacySettings(req.userId) });
});

router.patch("/me/privacy", requireAuth, async (req, res) => {
  const {
    allowInterestTargeting, allowBehavioralTracking,
    allowAggregateInsights, showVisitedPlaces,
  } = req.body || {};

  await ensurePrivacySettings(req.userId);
  const privacySettings = await prisma.privacySettings.update({
    where: { userId: req.userId },
    data: {
      ...(allowInterestTargeting !== undefined && { allowInterestTargeting: !!allowInterestTargeting }),
      ...(allowBehavioralTracking !== undefined && { allowBehavioralTracking: !!allowBehavioralTracking }),
      ...(allowAggregateInsights !== undefined && { allowAggregateInsights: !!allowAggregateInsights }),
      ...(showVisitedPlaces !== undefined && { showVisitedPlaces: !!showVisitedPlaces }),
    },
  });
  res.json({ privacySettings });
});

// --- Interests ---

router.get("/interests", async (_req, res) => {
  const interests = await prisma.interest.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  res.json({ interests });
});

router.put("/me/interests", requireAuth, async (req, res) => {
  const { interestIds } = req.body || {};
  if (!Array.isArray(interestIds)) return res.status(400).json({ error: "interestIds must be an array." });

  // Replace wholesale rather than diffing -- simpler and matches how the
  // UI works (submit the full selected set).
  await prisma.$transaction([
    prisma.userInterest.deleteMany({ where: { userId: req.userId } }),
    prisma.userInterest.createMany({
      data: interestIds.map((interestId) => ({ userId: req.userId, interestId })),
      skipDuplicates: true,
    }),
  ]);

  const interests = await prisma.userInterest.findMany({
    where: { userId: req.userId },
    include: { interest: true },
  });
  res.json({ interests: interests.map((ui) => ui.interest) });
});

// --- Visited places ---

router.get("/me/places", requireAuth, async (req, res) => {
  const places = await prisma.visitedPlace.findMany({
    where: { userId: req.userId },
    orderBy: { visitedAt: "desc" },
  });
  res.json({ places });
});

router.post("/me/places", requireAuth, async (req, res) => {
  const { name, address, latitude, longitude, googlePlaceId, appleMapsId, note, visitedAt, isPublic } = req.body || {};
  if (!name || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "A place needs a name and coordinates." });
  }

  const place = await prisma.visitedPlace.create({
    data: {
      userId: req.userId,
      name,
      address: address || null,
      latitude: Number(latitude),
      longitude: Number(longitude),
      googlePlaceId: googlePlaceId || null,
      appleMapsId: appleMapsId || null,
      note: note || null,
      isPublic: !!isPublic,
      ...(visitedAt && { visitedAt: new Date(visitedAt) }),
    },
  });
  res.status(201).json({ place });
});

router.delete("/me/places/:id", requireAuth, async (req, res) => {
  const place = await prisma.visitedPlace.findUnique({ where: { id: req.params.id } });
  if (!place || place.userId !== req.userId) return res.status(404).json({ error: "Place not found." });
  await prisma.visitedPlace.delete({ where: { id: place.id } });
  res.status(204).end();
});

// Public view of someone's places -- gated on BOTH their global
// showVisitedPlaces consent and each place's own isPublic flag.
router.get("/:username/places", optionalAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { username: req.params.username },
    include: { privacySettings: true },
  });
  if (!user) return res.status(404).json({ error: "That profile doesn't exist." });

  const isOwner = req.userId === user.id;
  if (!isOwner && !user.privacySettings?.showVisitedPlaces) {
    return res.json({ places: [] });
  }

  const places = await prisma.visitedPlace.findMany({
    where: { userId: user.id, ...(isOwner ? {} : { isPublic: true }) },
    orderBy: { visitedAt: "desc" },
  });
  res.json({ places });
});

module.exports = router;
