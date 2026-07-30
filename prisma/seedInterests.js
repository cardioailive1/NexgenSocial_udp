// Seeds the shared Interest tag list. Safe to run repeatedly (upserts by
// unique name). Run automatically on boot via the Dockerfile CMD, so a
// fresh deploy always has interests available for targeting.
const prisma = require("../src/lib/prisma");

const INTERESTS = [
  ["Football", "Sports"], ["Basketball", "Sports"], ["Soccer", "Sports"],
  ["Running", "Sports"], ["Fitness", "Sports"], ["Yoga", "Sports"],
  ["Movies", "Entertainment"], ["Music", "Entertainment"], ["Gaming", "Entertainment"],
  ["Live Streaming", "Entertainment"], ["Podcasts", "Entertainment"],
  ["Technology", "Tech"], ["AI & Machine Learning", "Tech"], ["Startups", "Tech"],
  ["Programming", "Tech"], ["Gadgets", "Tech"],
  ["Cooking", "Lifestyle"], ["Travel", "Lifestyle"], ["Fashion", "Lifestyle"],
  ["Photography", "Lifestyle"], ["Home & Garden", "Lifestyle"], ["Parenting", "Lifestyle"],
  ["Pets", "Lifestyle"],
  ["Investing", "Business"], ["Real Estate", "Business"], ["Entrepreneurship", "Business"],
  ["Marketing", "Business"], ["Personal Finance", "Business"],
  ["Politics", "News"], ["Local News", "News"], ["World News", "News"],
  ["Science", "Education"], ["History", "Education"], ["Books", "Education"],
  ["Health & Wellness", "Health"], ["Mental Health", "Health"], ["Nutrition", "Health"],
];

async function main() {
  for (const [name, category] of INTERESTS) {
    await prisma.interest.upsert({
      where: { name },
      update: { category },
      create: { name, category },
    });
  }
  console.log(`Seeded ${INTERESTS.length} interests.`);
}

// A hard timeout matters here because this runs during container boot: if
// the DB connection hangs rather than failing outright, an un-timed-out
// script would block the server from ever starting. Failing fast and
// letting the app boot without interests is strictly better than hanging.
const SEED_TIMEOUT_MS = 30000;

const timeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`Seeding timed out after ${SEED_TIMEOUT_MS}ms`)), SEED_TIMEOUT_MS)
);

Promise.race([main(), timeout])
  .catch((err) => {
    // Don't hard-fail the boot over seeding -- the app works fine without
    // interests, they just won't be selectable until this succeeds.
    console.error("Interest seeding failed (continuing anyway):", err.message);
  })
  .finally(async () => {
    // Await the disconnect and then exit explicitly. Without this the
    // process can linger on an open connection handle and never exit,
    // which during boot means the server never starts.
    try { await prisma.$disconnect(); } catch {}
    process.exit(0);
  });
