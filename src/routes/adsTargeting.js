const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Minimum number of distinct users an aggregate figure must cover before
// it's shown to an advertiser. Below this, small audiences can be
// de-anonymized by cross-referencing (a well-known weakness of "aggregate"
// stats), so we suppress the number entirely rather than round it. This is
// the mechanism that keeps "aggregate insights" genuinely aggregate rather
// than individual profiles with extra steps.
const K_ANONYMITY_THRESHOLD = 25;

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

// Does this ad's targeting criteria match this user? Every criterion is
// "unset means don't filter", so an ad with no targeting reaches everyone.
function adMatchesUser(ad, user, userInterestIds) {
  const age = ageFromBirthDate(user.birthDate);
  if (ad.targetMinAge != null && (age == null || age < ad.targetMinAge)) return false;
  if (ad.targetMaxAge != null && (age == null || age > ad.targetMaxAge)) return false;

  if (ad.targetGenders?.length && !ad.targetGenders.includes(user.gender)) return false;
  if (ad.targetCities?.length && !ad.targetCities.includes(user.city)) return false;
  if (ad.targetCountries?.length && !ad.targetCountries.includes(user.country)) return false;
  if (ad.targetRelationshipStatuses?.length && !ad.targetRelationshipStatuses.includes(user.relationshipStatus)) return false;

  if (ad.targetInterests?.length) {
    const wanted = ad.targetInterests.map((ti) => ti.interestId);
    if (!wanted.some((id) => userInterestIds.includes(id))) return false;
  }
  return true;
}

// --- Ad serving -----------------------------------------------------------
// Returns ads to display to the current user. If the person hasn't consented
// to interest targeting, they still see ads -- just untargeted ones. That's
// deliberate: consent shouldn't be coerced by withholding the free service,
// which is both an ethical point and (under GDPR) a legal one.
router.get("/serve", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 3, 10);

  const [user, privacy, userInterests] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId } }),
    prisma.privacySettings.findUnique({ where: { userId: req.userId } }),
    prisma.userInterest.findMany({ where: { userId: req.userId }, select: { interestId: true } }),
  ]);

  const allAds = await prisma.ad.findMany({
    where: { active: true },
    include: { targetInterests: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const targetingAllowed = !!privacy?.allowInterestTargeting;
  const userInterestIds = userInterests.map((ui) => ui.interestId);

  let selected;
  if (targetingAllowed) {
    selected = allAds.filter((ad) => adMatchesUser(ad, user, userInterestIds));
    // If nothing matches, fall back to untargeted ads so the ad slot isn't
    // simply empty for people with sparse profiles.
    if (selected.length === 0) {
      selected = allAds.filter((ad) => !ad.targetInterests.length && !ad.targetGenders?.length && ad.targetMinAge == null);
    }
  } else {
    // No consent: only serve ads that aren't demographically targeted at all.
    selected = allAds.filter(
      (ad) => !ad.targetInterests.length && !ad.targetGenders?.length && !ad.targetCities?.length &&
              !ad.targetCountries?.length && !ad.targetRelationshipStatuses?.length &&
              ad.targetMinAge == null && ad.targetMaxAge == null
    );
  }

  res.json({
    ads: selected.slice(0, limit).map((ad) => ({
      id: ad.id,
      category: ad.category,
      headline: ad.headline,
      body: ad.body,
      imageUrl: ad.imageUrl,
      targetUrl: ad.targetUrl,
      // Surfaced so the UI can honestly tell the person why they're seeing
      // this ad, matching the "why am I seeing this" principle used in the feed.
      wasTargeted: targetingAllowed,
    })),
    targetingEnabled: targetingAllowed,
  });
});

// --- Event tracking (impressions, clicks, conversions) -------------------
router.post("/events", requireAuth, async (req, res) => {
  const { adId, type, valueCents } = req.body || {};
  if (!["IMPRESSION", "CLICK", "CONVERSION"].includes(type)) {
    return res.status(400).json({ error: "type must be IMPRESSION, CLICK, or CONVERSION." });
  }

  const privacy = await prisma.privacySettings.findUnique({ where: { userId: req.userId } });

  // Consent gate. We still record the event for advertiser billing/reporting,
  // but WITHOUT the userId attached -- so the advertiser gets accurate counts
  // while the person's individual behavior isn't logged against them.
  const attachUser = !!privacy?.allowBehavioralTracking;

  await prisma.adEvent.create({
    data: {
      adId,
      userId: attachUser ? req.userId : null,
      type,
      valueCents: type === "CONVERSION" && valueCents != null ? Number(valueCents) : null,
    },
  });
  res.status(201).json({ recorded: true, linkedToAccount: attachUser });
});

// --- Advertiser-facing reporting ----------------------------------------
// Per-ad performance for ads YOU own. Counts are aggregate; no individual
// user identities are ever included in this response.
router.get("/:adId/insights", requireAuth, async (req, res) => {
  const ad = await prisma.ad.findUnique({
    where: { id: req.params.adId },
    include: { targetInterests: { include: { interest: true } } },
  });
  if (!ad || ad.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });

  const events = await prisma.adEvent.groupBy({
    by: ["type"],
    where: { adId: ad.id },
    _count: { _all: true },
    _sum: { valueCents: true },
  });

  const counts = { IMPRESSION: 0, CLICK: 0, CONVERSION: 0 };
  let revenueCents = 0;
  for (const row of events) {
    counts[row.type] = row._count._all;
    if (row.type === "CONVERSION") revenueCents = row._sum.valueCents || 0;
  }

  // Distinct reach, only counting events that had consent to be linked.
  const distinctUsers = await prisma.adEvent.findMany({
    where: { adId: ad.id, userId: { not: null } },
    distinct: ["userId"],
    select: { userId: true },
  });
  const reach = distinctUsers.length;

  res.json({
    ad: { id: ad.id, headline: ad.headline, category: ad.category, active: ad.active },
    targeting: {
      minAge: ad.targetMinAge,
      maxAge: ad.targetMaxAge,
      genders: ad.targetGenders,
      cities: ad.targetCities,
      countries: ad.targetCountries,
      relationshipStatuses: ad.targetRelationshipStatuses,
      interests: ad.targetInterests.map((ti) => ti.interest.name),
    },
    performance: {
      impressions: counts.IMPRESSION,
      clicks: counts.CLICK,
      conversions: counts.CONVERSION,
      clickThroughRate: counts.IMPRESSION ? +(counts.CLICK / counts.IMPRESSION * 100).toFixed(2) : 0,
      conversionRate: counts.CLICK ? +(counts.CONVERSION / counts.CLICK * 100).toFixed(2) : 0,
      revenueCents,
      // Suppressed below the k-anonymity threshold: with only a handful of
      // people in a segment, a "distinct reach" figure combined with narrow
      // targeting criteria can effectively identify individuals.
      distinctReach: reach >= K_ANONYMITY_THRESHOLD ? reach : null,
      distinctReachSuppressed: reach < K_ANONYMITY_THRESHOLD,
    },
  });
});

// --- Audience estimation (pre-campaign planning) -------------------------
// "How many people would this targeting reach?" -- the number advertisers
// actually need. Only counts users who consented to aggregate insights, and
// suppresses results below the k-anonymity threshold.
router.post("/audience-estimate", requireAuth, async (req, res) => {
  const { minAge, maxAge, genders, cities, countries, relationshipStatuses, interestIds } = req.body || {};

  const where = {
    privacySettings: { is: { allowAggregateInsights: true } },
    ...(genders?.length && { gender: { in: genders } }),
    ...(cities?.length && { city: { in: cities } }),
    ...(countries?.length && { country: { in: countries } }),
    ...(relationshipStatuses?.length && { relationshipStatus: { in: relationshipStatuses } }),
    ...(interestIds?.length && { interests: { some: { interestId: { in: interestIds } } } }),
  };

  if (minAge != null || maxAge != null) {
    const now = Date.now();
    const yearMs = 365.25 * 24 * 3600 * 1000;
    where.birthDate = {};
    // Older bound: born before (now - minAge years)
    if (minAge != null) where.birthDate.lte = new Date(now - minAge * yearMs);
    if (maxAge != null) where.birthDate.gte = new Date(now - (maxAge + 1) * yearMs);
  }

  const count = await prisma.user.count({ where });

  res.json({
    estimatedReach: count >= K_ANONYMITY_THRESHOLD ? count : null,
    suppressed: count < K_ANONYMITY_THRESHOLD,
    minimumThreshold: K_ANONYMITY_THRESHOLD,
    note: count < K_ANONYMITY_THRESHOLD
      ? `Fewer than ${K_ANONYMITY_THRESHOLD} people match. The exact count is withheld to protect individual privacy -- broaden your targeting.`
      : "Counts only include people who opted in to contributing to aggregate audience insights.",
  });
});

module.exports = router;
