const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const PROVIDERS = ["FACEBOOK", "INSTAGRAM", "X", "LINKEDIN", "TIKTOK", "GOOGLE"];

// --- Linked accounts ---
//
// PRODUCTION NOTE: real "Sign in with X" / Facebook Login / etc. is a
// three-step OAuth flow: (1) redirect the user to the provider's consent
// screen with your app's client ID, (2) the provider redirects back here
// with an authorization code, (3) this server exchanges that code for an
// access token using your app's client SECRET (never in frontend code).
// That requires registering a developer app with each platform and setting
// PROVIDER_CLIENT_ID / PROVIDER_CLIENT_SECRET env vars here. Passport.js has
// a ready-made strategy for most of these providers if you want to avoid
// hand-rolling the OAuth dance.
//
// Until those credentials exist, POST /connect below creates the
// SocialAccount record directly (no token), so the rest of the app —
// listing connections, showing "connected" badges, disconnecting — is
// fully wired and ready for the real handshake to be dropped in later.

router.get("/accounts", requireAuth, async (req, res) => {
  const accounts = await prisma.socialAccount.findMany({
    where: { userId: req.userId },
    select: { id: true, provider: true, displayName: true, connectedAt: true },
  });
  res.json({ accounts });
});

router.post("/accounts/:provider/connect", requireAuth, async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: "Unknown provider." });

  const { displayName } = req.body || {};
  const account = await prisma.socialAccount.upsert({
    where: { userId_provider: { userId: req.userId, provider } },
    update: { displayName: displayName || null, connectedAt: new Date() },
    create: { userId: req.userId, provider, displayName: displayName || null },
  });
  res.status(201).json({ account });
});

router.delete("/accounts/:provider", requireAuth, async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  await prisma.socialAccount.deleteMany({ where: { userId: req.userId, provider } });
  res.status(204).end();
});

// --- Invites ---
//
// Facebook, Instagram, and X do not let third-party apps read a user's
// full friends list (locked down platform-wide since ~2015 for privacy
// reasons) — so "invite friends from X" in practice means generating a
// link the user shares themselves, not pulling a contact list server-side.
// This is that: a trackable invite link/token, plus real (no-API-key-needed)
// share intents are wired into the frontend for email, SMS, and the major
// platforms' own public share-post dialogs.

router.post("/invites", requireAuth, async (req, res) => {
  const { channel, contact } = req.body || {};
  const invite = await prisma.invite.create({
    data: { senderId: req.userId, channel: channel || "link", contact: contact || null },
  });
  res.status(201).json({ invite });
});

router.get("/invites", requireAuth, async (req, res) => {
  const invites = await prisma.invite.findMany({
    where: { senderId: req.userId },
    orderBy: { createdAt: "desc" },
  });
  res.json({ invites });
});

// Public: resolve an invite token so the signup page can show "X invited you"
// and auto-friend the inviter once the invitee registers.
router.get("/invites/:token", async (req, res) => {
  const invite = await prisma.invite.findUnique({
    where: { token: req.params.token },
    include: { sender: { select: { username: true, displayName: true, avatarUrl: true } } },
  });
  if (!invite) return res.status(404).json({ error: "This invite link is invalid or expired." });
  res.json({ invite });
});

module.exports = router;
