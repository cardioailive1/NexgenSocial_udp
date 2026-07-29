const mediasoup = require("mediasoup");

// One mediasoup Worker is a separate OS process handling media for however
// many rooms get assigned to it. A single worker comfortably handles many
// concurrent small-to-medium streams; add more (one per CPU core is the
// usual rule of thumb) and round-robin across them as you scale up.
const WORKER_COUNT = Number(process.env.MEDIASOUP_WORKER_COUNT || 1);

// Single-port mode: every WebRTC transport in a worker shares ONE UDP+TCP
// port pair (ICE username-fragment routing tells them apart), instead of
// the more common "big ephemeral port range" approach. This is deliberate,
// not a simplification for its own sake -- it's what makes this deployable
// on hosts (Fly.io included) that won't remap UDP ports and don't want an
// app claiming 10,000 of them. Jitsi's media server uses the same trick.
// Each worker gets its own WebRtcServer on its own port, since a port can't
// be shared across workers (separate OS processes).
const BASE_WEBRTC_PORT = Number(process.env.MEDIASOUP_WEBRTC_PORT || 44444);
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1";
const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0";

// The codecs every room's Router will support. VP8 is chosen for broad
// browser compatibility without extra licensing considerations (vs H264).
const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
];

let workerPairs = []; // [{ worker, webRtcServer, port }]
let nextIndex = 0;

async function initWorkers() {
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = await mediasoup.createWorker({ logLevel: "warn" });
    worker.on("died", () => {
      console.error(`mediasoup worker ${worker.pid} died -- exiting so the process manager restarts us`);
      setTimeout(() => process.exit(1), 1000);
    });

    const port = BASE_WEBRTC_PORT + i; // each worker needs its own port
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: "udp", ip: LISTEN_IP, announcedAddress: ANNOUNCED_IP, port },
        { protocol: "tcp", ip: LISTEN_IP, announcedAddress: ANNOUNCED_IP, port },
      ],
    });

    workerPairs.push({ worker, webRtcServer, port });
    console.log(`mediasoup worker ${i + 1}/${WORKER_COUNT} started (pid ${worker.pid}, WebRTC port ${port})`);
  }
}

function getWorkerPair() {
  const pair = workerPairs[nextIndex];
  nextIndex = (nextIndex + 1) % workerPairs.length;
  return pair;
}

module.exports = { initWorkers, getWorkerPair, mediaCodecs, BASE_WEBRTC_PORT, WORKER_COUNT };
