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

CMD ["node", "src/index.js"]
