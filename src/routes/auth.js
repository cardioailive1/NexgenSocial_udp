const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

router.post("/register", async (req, res) => {
  const { email, username, password, displayName, inviteToken,
          acceptedTerms, policyVersion } = req.body || {};
  if (!email || !username || !password || !displayName) {
    return res.status(400).json({ error: "Email, username, password, and display name are all required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  // Enforced server-side, not just by a checkbox in the form -- otherwise
  // the record of consent could be bypassed by posting straight to the API,
  // which would undermine the entire point of having one.
  if (acceptedTerms !== true) {
    return res.status(400).json({
      error: "You must accept the Terms of Use and Privacy Policy to create an account.",
    });
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });
  if (existing) {
    return res.status(409).json({ error: "An account with that email or username already exists." });
  }

  // If they arrived via a shared invite link, look it up before creating the
  // account so a bad token doesn't fail signup outright -- it just quietly
  // skips the auto-friend step.
  let invite = null;
  if (inviteToken) {
    invite = await prisma.invite.findUnique({ where: { token: inviteToken } });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const acceptedAt = new Date();
  const user = await prisma.user.create({
    data: {
      email, username, passwordHash, displayName,
      // Storing WHEN and WHICH VERSION was accepted is what makes this a
      // usable record rather than just a boolean.
      acceptedTermsAt: acceptedAt,
      acceptedPrivacyAt: acceptedAt,
      acceptedPolicyVersion: policyVersion || null,
    },
  });

  if (invite && invite.status === "SENT" && invite.senderId !== user.id) {
    await prisma.$transaction([
      prisma.invite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedById: user.id } }),
      prisma.friendRequest.create({
        data: { senderId: invite.senderId, receiverId: user.id, status: "ACCEPTED", respondedAt: new Date() },
      }),
    ]);
  }

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { emailOrUsername, password } = req.body || {};
  if (!emailOrUsername || !password) {
    return res.status(400).json({ error: "Email/username and password are required." });
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
  });
  if (!user) return res.status(401).json({ error: "Incorrect email/username or password." });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Incorrect email/username or password." });

  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ user: publicUser(user) });
});

module.exports = router;
