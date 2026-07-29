require("dotenv").config();
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

attachSignaling(server)
  .then(() => {
    server.listen(PORT, () => console.log(`NexgenSocial API listening on :${PORT} (HTTP + live-stream SFU signaling at /ws/live)`));
  })
  .catch((err) => {
    console.error("Failed to start the live-stream SFU -- starting the rest of the API anyway:", err);
    server.listen(PORT, () => console.log(`NexgenSocial API listening on :${PORT} (live streaming unavailable)`));
  });
