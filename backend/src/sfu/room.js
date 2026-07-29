const { getWorkerPair, mediaCodecs } = require("./worker");

// One Room = one Router = one livestream's shared media space. Every
// participant (the broadcaster and each viewer) gets their own WebRTC
// transports within this shared router, which is what makes this a "real"
// SFU rather than a mesh: the broadcaster uploads video once, to the
// server; the server fans it out to every viewer from there.
const rooms = new Map(); // roomId -> Room

class Peer {
  constructor(id, role) {
    this.id = id;
    this.role = role; // "host" | "viewer"
    this.transports = new Map(); // transportId -> WebRtcTransport
    this.producers = new Map(); // producerId -> Producer
    this.consumers = new Map(); // consumerId -> Consumer
  }

  close() {
    this.consumers.forEach((c) => c.close());
    this.producers.forEach((p) => p.close());
    this.transports.forEach((t) => t.close());
  }
}

class Room {
  constructor(id) {
    this.id = id;
    this.router = null;
    this.peers = new Map(); // peerId -> Peer
  }

  async init() {
    const { worker, webRtcServer } = getWorkerPair();
    this.webRtcServer = webRtcServer;
    this.router = await worker.createRouter({ mediaCodecs });
  }

  addPeer(peerId, role) {
    const peer = new Peer(peerId, role);
    this.peers.set(peerId, peer);
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
    }
  }

  // Every producer (audio or video track) currently live in the room,
  // annotated with which peer owns it -- used to tell a newly-joined
  // viewer everything they should immediately try to consume.
  listProducers(excludePeerId) {
    const list = [];
    for (const [peerId, peer] of this.peers) {
      if (peerId === excludePeerId) continue;
      for (const [producerId, producer] of peer.producers) {
        list.push({ peerId, producerId, kind: producer.kind });
      }
    }
    return list;
  }

  isEmpty() {
    return this.peers.size === 0;
  }

  close() {
    this.peers.forEach((peer) => peer.close());
    this.router?.close();
  }
}

async function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId);
    await room.init();
    rooms.set(roomId, room);
  }
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function closeRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (room && room.isEmpty()) {
    room.close();
    rooms.delete(roomId);
  }
}

module.exports = { getOrCreateRoom, getRoom, closeRoomIfEmpty };
