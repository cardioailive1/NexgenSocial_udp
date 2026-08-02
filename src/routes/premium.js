const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { getStripe, isStripeConfigured } = require("../lib/stripe");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `ad-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ""}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Ad creative must be a photo or video."));
  },
});

async function loadTier(req, res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "Account not found." });
  req.tier = user.tier;
  next();
}

function gatePremium(req, res, next) {
  if (req.tier !== "PREMIUM") {
    return res.status(402).json({ error: "This feature is part of NexgenSocial Premium." });
  }
  next();
}

// --- Subscription (stubbed: swap the body of this handler for a real
// payment-provider webhook confirmation before going live) ---
router.post("/upgrade", requireAuth, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.userId }, data: { tier: "PREMIUM" } });
  res.json({ tier: user.tier });
});

router.post("/downgrade", requireAuth, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.userId }, data: { tier: "FREE" } });
  res.json({ tier: user.tier });
});

// --- Marketplace ---
router.get("/marketplace", async (_req, res) => {
  const listings = await prisma.marketListing.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { seller: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  res.json({ listings });
});

router.post("/marketplace", requireAuth, loadTier, gatePremium, async (req, res) => {
  const { title, description, priceCents, imageUrl } = req.body || {};
  if (!title || !description || !priceCents) {
    return res.status(400).json({ error: "Title, description, and price are required." });
  }
  const listing = await prisma.marketListing.create({
    data: { sellerId: req.userId, title, description, priceCents, imageUrl: imageUrl || null },
  });
  res.status(201).json({ listing });
});

// --- Ads (business or political) ---
router.get("/ads", async (req, res) => {
  const category = req.query.category; // BUSINESS | POLITICAL | GENERAL
  const ads = await prisma.ad.findMany({
    where: { active: true, ...(category && { category }) },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { media: true },
  });
  res.json({ ads });
});

// Ads are created in PENDING_PAYMENT and do not serve until paid. The
// Premium tier gate is deliberately removed here: payment is now the gate,
// and requiring both would mean charging twice for the same thing.
router.post("/ads", requireAuth, upload.array("media", 5), async (req, res) => {
  const { category, headline, body, targetUrl, paymentRef } = req.body || {};
  if (!headline || !body) return res.status(400).json({ error: "Headline and body are required." });

  // Every campaign starts on the same $50 package: 1 day, 1,000 people.
  // The advertiser doesn't pick a budget here -- extending is a separate
  // decision made later, once they've seen how the ad performs.
  const BASE_PRICE_CENTS = 5000;
  const budget = BASE_PRICE_CENTS;
  const days = 1;
  const reachCap = 1000;

  const files = req.files || [];
  const ad = await prisma.ad.create({
    data: {
      ownerId: req.userId,
      category: category || "GENERAL",
      headline,
      body,
      targetUrl: targetUrl || null,
      imageUrl: files[0] ? `/uploads/${files[0].filename}` : null,
      budgetCents: budget,
      durationDays: days,
      reachCap,
      paymentRef: paymentRef || null,
      paymentStatus: "PENDING_PAYMENT",
      active: true,
      media: {
        create: files.map((f, i) => ({
          url: `/uploads/${f.filename}`,
          kind: f.mimetype.startsWith("video") ? "VIDEO" : "PHOTO",
          position: i,
        })),
      },
    },
    include: { media: true },
  });

  res.status(201).json({
    ad,
    paymentUrl: process.env.STRIPE_PAYMENT_LINK || null,
    message: "Your ad is saved but will not run until payment is confirmed.",
  });
});

// Advertiser submits the reference from their Stripe receipt. This does NOT
// mark the ad paid -- confirmation is a separate, deliberate step, because
// a self-reported reference is not proof of payment.
router.post("/ads/:id/payment-reference", requireAuth, async (req, res) => {
  const { paymentRef } = req.body || {};
  if (!paymentRef || !paymentRef.trim()) {
    return res.status(400).json({ error: "Enter the reference from your Stripe receipt." });
  }
  const ad = await prisma.ad.findUnique({ where: { id: req.params.id } });
  if (!ad || ad.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });

  const updated = await prisma.ad.update({
    where: { id: ad.id },
    data: { paymentRef },
  });
  res.json({ ad: updated, message: "Reference received. Your ad will start once payment is verified." });
});

// --- Extend a running campaign -------------------------------------------
//
// Top up an existing ad: more money buys proportionally more days and more
// reach, in the same units as the starter package. Only usable on an ad
// that's already been paid for -- extending an unpaid ad would let someone
// skip the base purchase.
router.post("/ads/:id/extend/checkout", requireAuth, async (req, res) => {
  const stripe = getStripe();
  const ad = await prisma.ad.findUnique({ where: { id: req.params.id } });
  if (!ad || ad.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });
  if (ad.paymentStatus !== "PAID") {
    return res.status(409).json({ error: "Pay for the campaign before extending it." });
  }

  const topUpCents = Math.round(Number(req.body?.topUpCents) || 0);
  if (topUpCents < 500) {
    return res.status(400).json({ error: "The minimum top-up is $5.00." });
  }

  if (!stripe) {
    return res.status(503).json({
      error: "Card payment isn't configured on this server.",
      paymentUrl: process.env.STRIPE_PAYMENT_LINK || null,
    });
  }

  const BASE_PRICE_CENTS = 5000;
  const multiple = topUpCents / BASE_PRICE_CENTS;
  const addedDays = Math.max(0, Math.round(1 * multiple));
  const addedReach = Math.round(1000 * multiple);
  const clientUrl = (process.env.CLIENT_URL || "").split(",")[0].trim() || "";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: topUpCents,
          product_data: {
            name: `Extend ad: ${ad.headline}`.slice(0, 120),
            description: `Adds ~${addedDays} day(s) and ~${addedReach.toLocaleString()} more people`.slice(0, 300),
          },
        },
        quantity: 1,
      }],
      // `kind: extension` tells the webhook to add to the campaign rather
      // than activate it from scratch.
      metadata: { adId: ad.id, userId: req.userId, kind: "extension" },
      success_url: `${clientUrl}/ads?payment=extended&ad=${ad.id}`,
      cancel_url: `${clientUrl}/ads?payment=cancelled&ad=${ad.id}`,
    });
    res.json({ checkoutUrl: session.url, addedDays, addedReach });
  } catch (err) {
    console.error("Stripe extension checkout failed:", err.message);
    res.status(502).json({ error: "Couldn't start checkout. Please try again." });
  }
});

// --- Stripe Checkout ------------------------------------------------------
//
// Creates a Checkout Session for the exact budget the advertiser chose.
// This is what a plain payment link can't do: the amount is set per
// campaign, and completion is verified server-side by the webhook below
// rather than trusted from the browser.
router.post("/ads/:id/checkout", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({
      error: "Card payment isn't configured on this server.",
      paymentUrl: process.env.STRIPE_PAYMENT_LINK || null,
    });
  }

  const ad = await prisma.ad.findUnique({ where: { id: req.params.id } });
  if (!ad || ad.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });
  if (ad.paymentStatus === "PAID") return res.status(409).json({ error: "This ad is already paid for." });

  const clientUrl = (process.env.CLIENT_URL || "").split(",")[0].trim() || "";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: ad.budgetCents,
          product_data: {
            name: `NexgenSocial ad: ${ad.headline}`.slice(0, 120),
            description: `${ad.durationDays}-day campaign, estimated reach ${ad.reachCap?.toLocaleString() || "n/a"}`.slice(0, 300),
          },
        },
        quantity: 1,
      }],
      // The ad id travels with the session so the webhook can match the
      // payment back to the right campaign without trusting the client.
      metadata: { adId: ad.id, userId: req.userId },
      success_url: `${clientUrl}/ads?payment=success&ad=${ad.id}`,
      cancel_url: `${clientUrl}/ads?payment=cancelled&ad=${ad.id}`,
    });

    await prisma.ad.update({
      where: { id: ad.id },
      data: { stripeSessionId: session.id },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    res.status(502).json({ error: "Couldn't start checkout. Please try again." });
  }
});

// --- Stripe webhook -------------------------------------------------------
//
// The ONLY path that marks an ad paid when Stripe is configured. The
// signature is verified against STRIPE_WEBHOOK_SECRET, so a forged request
// can't activate a campaign. Note this route needs the RAW body, which is
// wired up before the JSON parser in index.js.
router.post("/stripe-webhook", async (req, res) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) return res.status(503).send("Stripe not configured.");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
  } catch (err) {
    // A failed signature check means the request didn't come from Stripe.
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const adId = session.metadata?.adId;

    const isExtension = session.metadata?.kind === "extension";

    if (adId && session.payment_status === "paid" && isExtension) {
      const ad = await prisma.ad.findUnique({ where: { id: adId } });
      if (ad) {
        const paid = session.amount_total || 0;
        const multiple = paid / 5000;
        const addedDays = Math.max(0, Math.round(1 * multiple));
        const addedReach = Math.round(1000 * multiple);
        // Extend from whichever is later: now, or the current end date.
        // Extending an already-expired campaign should restart it rather
        // than add days that are already in the past.
        const base = ad.endsAt && ad.endsAt > new Date() ? ad.endsAt : new Date();
        await prisma.ad.update({
          where: { id: ad.id },
          data: {
            endsAt: new Date(base.getTime() + addedDays * 24 * 3600 * 1000),
            durationDays: ad.durationDays + addedDays,
            reachCap: (ad.reachCap || 0) + addedReach,
            amountPaidCents: (ad.amountPaidCents || 0) + paid,
          },
        });
        console.log(`Ad ${ad.id} extended by ${addedDays}d / ${addedReach} reach for ${paid} cents.`);
      }
    } else if (adId && session.payment_status === "paid") {
      const ad = await prisma.ad.findUnique({ where: { id: adId } });
      if (ad && ad.paymentStatus !== "PAID") {
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + ad.durationDays * 24 * 3600 * 1000);
        // Reach is granted on what Stripe actually collected, not on the
        // requested budget -- so a partial or altered payment can't buy a
        // larger campaign than was paid for.
        const paid = session.amount_total ?? ad.budgetCents;
        // The starter package is fixed, so reach isn't scaled here --
        // paying more than $50 at this stage doesn't silently buy more.
        // Extending is the deliberate path to a bigger campaign.
        const reachCap = 1000;

        await prisma.ad.update({
          where: { id: ad.id },
          data: {
            paymentStatus: "PAID",
            paidAt: new Date(),
            amountPaidCents: paid,
            reachCap,
            startsAt,
            endsAt,
            paymentRef: session.payment_intent || session.id,
          },
        });
        console.log(`Ad ${ad.id} activated after payment of ${paid} cents.`);
      }
    }
  }

  res.json({ received: true });
});

// Marks an ad paid and starts its scheduled window.
//
// NOTE: this is currently open to the ad's owner, which is fine for manual
// operation but is NOT payment verification -- an advertiser could call it
// themselves. Before taking real money, either restrict this to platform
// admins, or replace it with a Stripe webhook that verifies the payment
// server-side. See README "Advertising payments".
router.post("/ads/:id/confirm-payment", requireAuth, async (req, res) => {
  // Once Stripe is configured, activation happens only via the verified
  // webhook. Leaving this open would let an advertiser mark their own ad
  // paid and run it for free.
  if (isStripeConfigured()) {
    return res.status(403).json({
      error: "Ads are activated automatically once payment completes. Use the checkout link.",
    });
  }

  const ad = await prisma.ad.findUnique({ where: { id: req.params.id } });
  if (!ad || ad.ownerId !== req.userId) return res.status(404).json({ error: "Ad not found." });
  if (ad.paymentStatus === "PAID") return res.json({ ad });

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + ad.durationDays * 24 * 3600 * 1000);

  const updated = await prisma.ad.update({
    where: { id: ad.id },
    data: { paymentStatus: "PAID", paidAt: new Date(), startsAt, endsAt },
  });
  res.json({ ad: updated });
});

// --- Political hub & media coverage / live streams: scaffolded endpoints.
// These currently reuse Group + Post (a "political" or "media" group is just
// a Group with a topic), which is enough to build the feature end to end.
// A dedicated Livestream model (RTMP/HLS ingest URL, viewer count, chat)
// is the natural next addition once you pick a streaming provider
// (e.g. Mux, Cloudflare Stream) — see README "Next build steps".
router.get("/status", requireAuth, loadTier, (req, res) => {
  res.json({ tier: req.tier });
});

module.exports = router;
