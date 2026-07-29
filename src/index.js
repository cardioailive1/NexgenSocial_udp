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

app.use(cors({ origin: process.env.CLIENT_URL || "*" }));
app.use(express.json());
app.use(morgan("tiny"));

// Served statically for local dev. In production, point mediaUrl at your
// object-storage bucket instead (see routes/posts.js note).
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/health", (_req, res) => res.json({ ok: true }));

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

app.use((err, _req, res, _next) => {
  console.error(err);
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
