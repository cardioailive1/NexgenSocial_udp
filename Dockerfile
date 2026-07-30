# mediasoup compiles a native worker binary at install time. Prebuilt
# binaries exist for common platforms, but Fly's build environment doesn't
# always match one exactly, so this image includes the toolchain needed to
# build from source as a fallback -- confirmed necessary by testing this
# exact install in a similar sandboxed Linux environment during development.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ninja-build \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Requires network access to Prisma's binary host at build time (Fly's
# build servers have normal internet access, unlike some sandboxed CI
# environments -- if your build environment blocks outbound network during
# this step, that's the thing to fix, not this command).
RUN npx prisma generate

EXPOSE 4000

# `prisma migrate deploy` only applies migration *files* -- this project
# was never run through `prisma migrate dev` locally (that needs a live DB
# connection to generate them), so prisma/migrations/ is empty and deploy
# had nothing to apply, even though it connected fine. `db push` instead
# syncs the schema directly against the database using the same engine, no
# migration files required. It refuses to run (rather than silently
# dropping data) if a future schema change would be destructive, unless
# --accept-data-loss is passed -- which is NOT set here on purpose, so
# you'll see it fail loudly rather than lose data if that ever comes up.
# Once the schema stabilizes, switching to real versioned migrations
# (`prisma migrate dev` run locally against a real DB, committing the
# resulting prisma/migrations/ folder, then back to `migrate deploy` here)
# is the standard next step for a production app -- db push is the right
# tool for right now, not forever.
# Chaining these with && was a mistake: it meant a failure in EITHER the
# schema push or the interest seeding prevented the server from starting at
# all, so the app stopped listening entirely and the host reported
# "instance refused connection" -- turning a recoverable data-layer hiccup
# into a total outage. Now each prep step logs its failure and execution
# continues regardless; the server always gets to start. A failed db push
# means some queries error until it's fixed, which is far better than the
# whole API being unreachable.
CMD ["sh", "-c", "npx prisma db push --skip-generate || echo 'WARNING: prisma db push failed -- starting server anyway'; node prisma/seedInterests.js || echo 'WARNING: interest seeding failed -- starting server anyway'; node src/index.js"]
