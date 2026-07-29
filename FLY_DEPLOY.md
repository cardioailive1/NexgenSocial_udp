# Deploying the backend to Fly.io

This covers deploying **just the backend** (API + WebSocket signaling +
mediasoup SFU) to Fly.io, since it's the piece that needs real UDP
networking for live streaming. The frontend can stay wherever it already
is (e.g. Render as a Node web service, per the main README) — just point
it at this backend's URL once deployed.

## Why Fly.io specifically for this piece

Live video needs UDP reachable from the internet; most PaaS "web service"
hosting (Render included) only proxies HTTP(S). Fly.io supports UDP
directly. Everything else this backend does (REST API, auth, the
WebSocket signaling handshake itself) is plain HTTP and would run
anywhere — UDP is only needed for the actual audio/video packets.

## What you need before starting

- The [flyctl CLI](https://fly.io/docs/flyctl/install/) installed and
  logged in (`fly auth login`)
- A Postgres database reachable from the internet — reuse the one from
  the Render blueprint if you already created it, use
  [Fly Postgres](https://fly.io/docs/postgres/), or any other provider
  (Neon, Supabase, etc.) all work fine. This guide doesn't move your
  database — only the Node backend.

## Steps

1. **Create the app** (from inside the `backend/` folder):
   ```bash
   cd backend
   fly launch --no-deploy
   ```
   When prompted, say **no** to adding a Postgres database if you're
   reusing an existing one. `fly launch` will detect the `Dockerfile` and
   may offer to overwrite `fly.toml` — decline, or re-copy the one in this
   repo afterward; it already has the UDP/TCP service blocks configured.

2. **Allocate a dedicated IPv4 address.** This is the part that costs a
   small monthly fee and is easy to miss: UDP on Fly.io does **not** work
   over the free shared IPv4 every app gets, only a dedicated one.
   ```bash
   fly ips allocate-v4
   ```
   Note the IP address it prints (`fly ips list` shows it again anytime).

3. **Set secrets** — anything sensitive or environment-specific goes here,
   not in `fly.toml`:
   ```bash
   fly secrets set \
     DATABASE_URL="postgresql://..." \
     JWT_SECRET="$(openssl rand -hex 32)" \
     CLIENT_URL="https://your-frontend-url" \
     SPORTSDB_API_KEY="3" \
     MEDIASOUP_ANNOUNCED_IP="<the IP from step 2>"
   ```

4. **Create the persistent volume for uploaded photos/videos** (do this
   BEFORE the first deploy below -- `fly.toml` references this volume by
   name, and deploying before it exists will fail):
   ```bash
   fly volumes create nexgensocial_uploads --size 1 -a nexgensocial-udp --region iad
   ```
   Use the same region as `primary_region` in `fly.toml`. 1GB is plenty to
   start; resize later with `fly volumes extend` if needed. Without this,
   every uploaded photo/video lives on the container's own disk and is
   silently deleted on the next restart or redeploy -- the post/database
   record survives, but the actual file doesn't, which shows up as a
   broken image or video player.

5. **Deploy:**
   ```bash
   fly deploy
   ```
   Watch the build logs — this is where mediasoup compiles its native
   worker binary, which takes a minute or two the first time.

6. **The schema syncs to the database automatically on every boot** -- the
   container's startup command is `npx prisma db push && node src/index.js`,
   so there's no separate manual step needed here, on this deploy or after
   most schema changes. (This project doesn't use versioned migration files
   yet -- `db push` syncs the schema directly. If `DATABASE_URL` isn't set
   correctly, you'll see that fail clearly in the boot logs, rather than
   the server starting and every individual request failing instead.)

7. **Point your frontend at this backend.** Wherever the frontend is
   deployed (Render, etc.), set `VITE_API_URL` to
   `https://<your-app-name>.fly.dev` and redeploy it (Vite bakes this in
   at build time, so a plain restart isn't enough).

8. **Sanity-check it actually works:**
   ```bash
   curl https://<your-app-name>.fly.dev/health
   ```
   should return `{"ok":true}`. Then try going live from the deployed
   frontend and watching from a second device/browser — if video doesn't
   connect, the almost-always cause is step 2 or 3: double check
   `MEDIASOUP_ANNOUNCED_IP` is the actual dedicated IP, not a placeholder.

## Scaling beyond one machine

If you outgrow a single machine, know that `MEDIASOUP_WORKER_COUNT` scales
workers *within* one machine (roughly one per CPU core), which is
different from running multiple Fly machines. Running multiple machines
for this specific service needs peers on different machines to be able to
route media to each other or share room state — that's a real distributed-
systems problem (mediasoup supports piping media between routers on
different hosts for exactly this), not a config flag, and is out of scope
for what's built here. For a while, one reasonably sized machine
(`cpus = 2` or so) handling everything will take you further than you'd
expect.
