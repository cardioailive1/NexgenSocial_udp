const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    const unique = `listing-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname) || ""}`);
  },
});

// Up to 10 files per listing. Real listings (a car, an apartment) genuinely
// need multiple angles plus often a walkthrough video -- one image was the
// single biggest gap in the marketplace.
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Listings accept photos and videos only."));
  },
});

const sellerSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

function serialize(listing) {
  const media = (listing.media || []).sort((a, b) => a.position - b.position);
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    priceCents: listing.priceCents,
    condition: listing.condition,
    location: listing.location,
    status: listing.status,
    createdAt: listing.createdAt,
    seller: listing.seller,
    media: media.map((m) => ({ id: m.id, url: m.url, kind: m.kind, position: m.position })),
    // Falls back to the legacy single-image field so listings created
    // before this feature existed still show a picture.
    coverUrl: media.find((m) => m.kind === "PHOTO")?.url || listing.imageUrl || null,
    photoCount: media.filter((m) => m.kind === "PHOTO").length,
    videoCount: media.filter((m) => m.kind === "VIDEO").length,
  };
}

router.get("/", optionalAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const listings = await prisma.marketListing.findMany({
    where: {
      status: "ACTIVE",
      ...(q && {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      }),
    },
    orderBy: { createdAt: "desc" },
    take: 60,
    include: { seller: sellerSelect, media: true },
  });
  res.json({ listings: listings.map(serialize) });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const listing = await prisma.marketListing.findUnique({
    where: { id: req.params.id },
    include: { seller: sellerSelect, media: true },
  });
  if (!listing) return res.status(404).json({ error: "Listing not found." });
  res.json({ listing: serialize(listing) });
});

router.post("/", requireAuth, upload.array("media", 10), async (req, res) => {
  const { title, description, priceCents, condition, location } = req.body || {};
  if (!title || !description || priceCents === undefined || priceCents === "") {
    return res.status(400).json({ error: "Title, description, and price are required." });
  }

  const price = Math.round(Number(priceCents));
  if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: "Enter a valid price." });

  const files = req.files || [];
  const listing = await prisma.marketListing.create({
    data: {
      sellerId: req.userId,
      title,
      description,
      priceCents: price,
      condition: condition || null,
      location: location || null,
      media: {
        create: files.map((f, i) => ({
          url: `/uploads/${f.filename}`,
          kind: f.mimetype.startsWith("video") ? "VIDEO" : "PHOTO",
          position: i,
        })),
      },
    },
    include: { seller: sellerSelect, media: true },
  });

  res.status(201).json({ listing: serialize(listing) });
});

// Add media to an existing listing, appended after whatever's already there.
router.post("/:id/media", requireAuth, upload.array("media", 10), async (req, res) => {
  const listing = await prisma.marketListing.findUnique({
    where: { id: req.params.id },
    include: { media: true },
  });
  if (!listing || listing.sellerId !== req.userId) return res.status(404).json({ error: "Listing not found." });

  const startPosition = listing.media.length;
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: "No files received." });

  await prisma.listingMedia.createMany({
    data: files.map((f, i) => ({
      listingId: listing.id,
      url: `/uploads/${f.filename}`,
      kind: f.mimetype.startsWith("video") ? "VIDEO" : "PHOTO",
      position: startPosition + i,
    })),
  });

  const updated = await prisma.marketListing.findUnique({
    where: { id: listing.id },
    include: { seller: sellerSelect, media: true },
  });
  res.status(201).json({ listing: serialize(updated) });
});

router.delete("/:id/media/:mediaId", requireAuth, async (req, res) => {
  const media = await prisma.listingMedia.findUnique({
    where: { id: req.params.mediaId },
    include: { listing: true },
  });
  if (!media || media.listing.sellerId !== req.userId) return res.status(404).json({ error: "Media not found." });
  await prisma.listingMedia.delete({ where: { id: media.id } });
  res.status(204).end();
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { title, description, priceCents, condition, location, status } = req.body || {};
  const listing = await prisma.marketListing.findUnique({ where: { id: req.params.id } });
  if (!listing || listing.sellerId !== req.userId) return res.status(404).json({ error: "Listing not found." });

  const updated = await prisma.marketListing.update({
    where: { id: listing.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(priceCents !== undefined && { priceCents: Math.round(Number(priceCents)) }),
      ...(condition !== undefined && { condition: condition || null }),
      ...(location !== undefined && { location: location || null }),
      ...(status !== undefined && ["ACTIVE", "SOLD", "WITHDRAWN"].includes(status) && { status }),
    },
    include: { seller: sellerSelect, media: true },
  });
  res.json({ listing: serialize(updated) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const listing = await prisma.marketListing.findUnique({ where: { id: req.params.id } });
  if (!listing || listing.sellerId !== req.userId) return res.status(404).json({ error: "Listing not found." });
  await prisma.marketListing.delete({ where: { id: listing.id } });
  res.status(204).end();
});

module.exports = router;
