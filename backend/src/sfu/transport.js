// Creates a WebRTC transport bound to the room's single-port WebRtcServer
// (see worker.js for why it's single-port). Each transport still handles
// exactly one peer's media independently -- WebRtcServer only means they
// all share the same UDP/TCP socket underneath, multiplexed by ICE
// username fragment.
async function createWebRtcTransport(router, webRtcServer) {
  const transport = await router.createWebRtcTransport({
    webRtcServer,
    initialAvailableOutgoingBitrate: 800000,
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

module.exports = { createWebRtcTransport };
