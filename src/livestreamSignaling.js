const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");
const { initWorkers } = require("./sfu/worker");
const { getOrCreateRoom, getRoom, closeRoomIfEmpty } = require("./sfu/room");
const { createWebRtcTransport } = require("./sfu/transport");

// A dedicated SFU-based live stream engine, replacing the earlier
// peer-to-peer mesh. The protocol is a small JSON-RPC over WebSocket:
// client sends { reqId, method, data }, server replies { reqId, ok, data }
// (or { reqId, ok:false, error }); the server also pushes one-way
// notifications { notification, data } for events like a new producer
// appearing or a peer leaving.
//
// Every peer (host or viewer) gets their own send/recv WebRTC transports
// within the room's shared mediasoup Router -- the actual video/audio never
// passes through this Node process itself, only the small signaling
// messages do. That's what lets one host's upload fan out efficiently to
// many viewers instead of one connection per viewer from the host's own
// bandwidth (the mesh's limitation).

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function reply(ws, reqId, data) {
  send(ws, { reqId, ok: true, data });
}

function replyError(ws, reqId, message) {
  send(ws, { reqId, ok: false, error: message });
}

function notify(peerWsById, peerId, payload) {
  const ws = peerWsById.get(peerId);
  if (ws) send(ws, { notification: payload.type, data: payload.data });
}

function broadcastToRoom(room, peerWsById, excludePeerId, payload) {
  for (const peerId of room.peers.keys()) {
    if (peerId === excludePeerId) continue;
    notify(peerWsById, peerId, payload);
  }
}

async function attachSignaling(httpServer) {
  await initWorkers();

  const wss = new WebSocketServer({ server: httpServer, path: "/ws/live" });
  const peerWsById = new Map(); // peerId -> ws, global across rooms (peerIds are unique)

  wss.on("connection", (ws) => {
    let peerId = null;
    let roomId = null;
    let role = null;

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { reqId, method, data } = msg;

      try {
        // --- join: must come first. Verifies host identity against the DB
        // record so only the actual stream owner can produce as "host". ---
        if (method === "join") {
          roomId = data.roomId;
          role = data.role === "host" ? "host" : "viewer";
          peerId = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Rooms come in three flavours, distinguished by an id prefix.
          // Previously EVERY "host" join was looked up in the livestream
          // table -- so a call joining as `call-<id>` found no livestream,
          // was rejected outright, and neither party ever connected. That
          // was the cause of calls ringing forever without arriving.
          let userId = null;
          try { userId = jwt.verify(data.token, process.env.JWT_SECRET).sub; } catch {}

          if (roomId.startsWith("call-")) {
            // 1:1 call. Both sides publish, so both join as "host"; the
            // check is simply that you're one of the two participants.
            const callId = roomId.slice("call-".length);
            const call = await prisma.call.findUnique({ where: { id: callId } });
            if (!call) return replyError(ws, reqId, "That call no longer exists.");
            if (!userId || (call.callerId !== userId && call.calleeId !== userId)) {
              return replyError(ws, reqId, "You're not a participant in this call.");
            }
            if (["ENDED", "DECLINED", "MISSED"].includes(call.status)) {
              return replyError(ws, reqId, "That call has already ended.");
            }
          } else if (roomId.startsWith("meet-")) {
            // Meeting room. Anyone with the code can join; hosting rights
            // are enforced per-action in routes/meetings.js rather than at
            // the transport layer.
            const meetingId = roomId.slice("meet-".length);
            const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
            if (!meeting) return replyError(ws, reqId, "That meeting no longer exists.");
            if (meeting.status === "ENDED") return replyError(ws, reqId, "That meeting has ended.");
          } else if (role === "host") {
            // Livestream: only the stream's owner may broadcast.
            const stream = await prisma.livestream.findUnique({ where: { id: roomId } });
            if (!stream || stream.hostId !== userId || stream.status !== "LIVE") {
              return replyError(ws, reqId, "You're not authorized to host this stream.");
            }
          }

          const room = await getOrCreateRoom(roomId);
          room.addPeer(peerId, role);
          peerWsById.set(peerId, ws);

          broadcastToRoom(room, peerWsById, peerId, {
            type: "peerJoined",
            data: { peerId, role },
          });

          return reply(ws, reqId, {
            peerId,
            rtpCapabilities: room.router.rtpCapabilities,
            existingProducers: room.listProducers(peerId),
          });
        }

        // Every method below requires an established room/peer.
        const room = getRoom(roomId);
        const peer = room?.peers.get(peerId);
        if (!room || !peer) return replyError(ws, reqId, "Not joined to a room.");

        if (method === "createTransport") {
          const { transport, params } = await createWebRtcTransport(room.router, room.webRtcServer);
          peer.transports.set(transport.id, transport);
          return reply(ws, reqId, params);
        }

        if (method === "connectTransport") {
          const transport = peer.transports.get(data.transportId);
          if (!transport) return replyError(ws, reqId, "Unknown transport.");
          await transport.connect({ dtlsParameters: data.dtlsParameters });
          return reply(ws, reqId, { connected: true });
        }

        if (method === "produce") {
          // In a livestream only the host publishes. In a call or a meeting
          // every participant does -- blocking that here would leave people
          // connected but permanently silent.
          const isMultiPublisher = roomId.startsWith("call-") || roomId.startsWith("meet-");
          if (!isMultiPublisher && role !== "host") {
            return replyError(ws, reqId, "Only the host can publish media.");
          }
          const transport = peer.transports.get(data.transportId);
          if (!transport) return replyError(ws, reqId, "Unknown transport.");

          const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters });
          peer.producers.set(producer.id, producer);

          broadcastToRoom(room, peerWsById, peerId, {
            type: "newProducer",
            data: { peerId, producerId: producer.id, kind: producer.kind },
          });

          return reply(ws, reqId, { id: producer.id });
        }

        if (method === "consume") {
          if (!room.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
            return replyError(ws, reqId, "Can't consume that producer with the given capabilities.");
          }
          const transport = peer.transports.get(data.transportId);
          if (!transport) return replyError(ws, reqId, "Unknown transport.");

          const consumer = await transport.consume({
            producerId: data.producerId,
            rtpCapabilities: data.rtpCapabilities,
            paused: true, // client resumes once its media element is ready, avoiding a race
          });
          peer.consumers.set(consumer.id, consumer);

          return reply(ws, reqId, {
            id: consumer.id,
            producerId: data.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          });
        }

        if (method === "resumeConsumer") {
          const consumer = peer.consumers.get(data.consumerId);
          if (!consumer) return replyError(ws, reqId, "Unknown consumer.");
          await consumer.resume();
          return reply(ws, reqId, { resumed: true });
        }

        return replyError(ws, reqId, `Unknown method: ${method}`);
      } catch (err) {
        console.error("signaling error:", err);
        return replyError(ws, reqId, "Internal signaling error.");
      }
    });

    ws.on("close", () => {
      if (!roomId || !peerId) return;
      const room = getRoom(roomId);
      if (!room) return;
      room.removePeer(peerId);
      peerWsById.delete(peerId);
      broadcastToRoom(room, peerWsById, peerId, { type: "peerClosed", data: { peerId } });
      closeRoomIfEmpty(roomId);
    });
  });

  return wss;
}

module.exports = { attachSignaling };
