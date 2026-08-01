require("dotenv").config();
// Must be required before any routes are defined. Patches Express so an
// error thrown inside an `async` route handler is caught and forwarded to
// the error-handling middleware below, instead of becoming an unhandled
// promise rejection -- which, left unhandled, crashes the entire Node
// process (not just that one request) as of Node 15+. Verified this both
// ways: without this, one bad request (e.g. a Prisma error) took the whole
// server down mid-response; with it, the same error returns a clean 500
// and the server keeps running.
require("express-async-errors");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const friendRoutes = require("./routes/friends");
const followRoutes = require("./routes/follows");
const postRoutes = require("./routes/posts");
const groupRoutes = require("./routes/groups");
const premiumRoutes = require("./routes/premium");
const socialRoutes = require("./routes/social");
const circleRoutes = require("./routes/circles");
const newsRoutes = require("./routes/news");
const sportsRoutes = require("./routes/sports");
const livestreamRoutes = require("./routes/livestreams");
const profileRoutes = require("./routes/profile");
const adsTargetingRoutes = require("./routes/adsTargeting");
const reelRoutes = require("./routes/reels");
const marketplaceRoutes = require("./routes/marketplace");
const politicalRoutes = require("./routes/political");
const newsroomRoutes = require("./routes/newsrooms");
const jobRoutes = require("./routes/jobs");
const messageRoutes = require("./routes/messages");
const { attachSignaling } = require("./livestreamSignaling");

// Belt-and-suspenders: express-async-errors covers anything thrown inside
// a route handler, but this catches anything else that might reject
// outside that cycle (a stray timer, a background task) so it can never
// silently take the whole process down again.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection (process staying alive):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (process staying alive):", err);
});

const app = express();

// CLIENT_URL can be a single origin or a comma-separated list (e.g. both
// your Render .onrender.com URL and a custom domain at once) -- a plain
// single-string match broke the moment a second, equally valid frontend
// origin (a custom domain) started being used alongside the original one.
const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // no Origin header (server-to-server calls, curl, health checks) -- allow
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true); // CLIENT_URL not set: allow all (dev-friendly default)
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json());
app.use(morgan("tiny"));

// Served statically for local dev. In production, point mediaUrl at your
// object-storage bucket instead (see routes/posts.js note).
// Explicit Content-Type + Cross-Origin-Resource-Policy headers matter here
// specifically because the frontend and this API are on genuinely
// different domains (a custom domain + fly.dev). Express's default static
// serving doesn't reliably set a correct Content-Type for .webm on every
// platform, and without a Content-Type the browser can't confirm a
// cross-origin subresource is safe to render as media -- Firefox's Opaque
// Response Blocking (and Chrome has an equivalent) silently drops it
// rather than play it, even though the file itself is completely fine
// (confirmed: it loads and plays when navigated to directly, since that's
// a top-level request, not a blocked cross-origin subresource load).
const UPLOAD_MIME_TYPES = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
app.use("/uploads", express.static(path.join(__dirname, "uploads"), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (UPLOAD_MIME_TYPES[ext]) res.setHeader("Content-Type", UPLOAD_MIME_TYPES[ext]);
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  },
}));

app.get("/health", (_req, res) => res.json({
  ok: true,
  // Temporary diagnostic: shows exactly what CORS origins the server is
  // actually configured with right now, to settle typo/trailing-slash/
  // stale-deploy questions definitively instead of by inspection. Remove
  // this field once CORS is confirmed working end to end.
  allowedOrigins,
}));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/follows", followRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/premium", premiumRoutes);
app.use("/api/social", socialRoutes);
app.use("/api/circles", circleRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/sports", sportsRoutes);
app.use("/api/livestreams", livestreamRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/ads", adsTargetingRoutes);
app.use("/api/reels", reelRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/political", politicalRoutes);
app.use("/api/newsrooms", newsroomRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/messages", messageRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  // Multer's file-size limit and our own fileFilter validation messages
  // (e.g. "Profile photo must be an image.") are safe and useful to show
  // as-is; anything else stays generic so we don't leak internals.
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "That file is too large." });
  }
  if (err.message && err.message.includes("must be")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Something went wrong on our end." });
});

const PORT = process.env.PORT || 4000;
const server = require("http").createServer(app);

// Start listening FIRST, unconditionally -- Fly (and most PaaS health
// checks) expect the port to open quickly and independently of anything
// else. mediasoup worker startup spawns a separate OS process and talks to
// it over a pipe, which is slower and has more ways to fail (resource
// limits, missing shared libs, port binding issues) than plain HTTP setup.
// Gating server.listen() on that finishing first meant a slow or hung
// mediasoup init could prevent the port from ever opening at all, which is
// worse than losing live streaming while everything else stays up.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`NexgenSocial API listening on :${PORT}`);
});

attachSignaling(server)
  .then(() => console.log("Live-stream SFU signaling attached at /ws/live"))
  .catch((err) => console.error("Live-stream SFU failed to start -- rest of the API is unaffected:", err));
