// CEVIRI - Online odada kamera (sessiz goruntu)
//
// Her katilimci cifti arasinda dogrudan WebRTC baglantisi kurulur (en fazla
// 6 kisi = 5 baglanti). Goruntu sesSIZ gider: mikrofon konusma tanimaya
// ayrilmis kalir, duyulan ses herkesin kendi dilindeki ceviri seslendirmesidir.
// Baglanti kurma mesajlari (teklif/cevap/aday) odanin sifreli kanalindan gider.
// "Kibar esler" (perfect negotiation) yontemiyle iki taraf ayni anda teklif
// yaparsa da karisiklik olmaz.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const VIDEO_CONSTRAINTS = {
  video: {
    facingMode: 'user',
    width: { ideal: 320 },
    height: { ideal: 240 },
    frameRate: { ideal: 15, max: 20 },
  },
  audio: false,
};
const MAX_BITRATE = 300000; // ~300 kbps: 6 kisilik odada mobil veriyi korur

export function createVideoMesh({ selfId, roomCode, sendSignal, onRemoteStream, onPeerState }) {
  const peers = new Map(); // id -> { pc, polite, makingOffer, ignoreOffer, sender }
  let localStream = null;
  let destroyed = false;

  function send(to, data) {
    if (!destroyed) sendSignal(to, data);
  }

  function limitBitrate(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = MAX_BITRATE;
      sender.setParameters(params).catch(() => {});
    } catch {
      // eski tarayici
    }
  }

  function addLocalTrack(peer) {
    if (!localStream || peer.sender) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    peer.sender = peer.pc.addTrack(track, localStream);
    limitBitrate(peer.sender);
  }

  function createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { id, pc, polite: String(selfId) > String(id), makingOffer: false, ignoreOffer: false, sender: null };
    peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send(id, { description: pc.localDescription.toJSON() });
      } catch {
        // yeniden denenir
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send(id, { candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = (streams && streams[0]) || new MediaStream([track]);
      onRemoteStream(id, stream);
      track.addEventListener('ended', () => onRemoteStream(id, null));
    };
    pc.onconnectionstatechange = () => {
      if (onPeerState) onPeerState(id, pc.connectionState);
    };
    addLocalTrack(peer);
    return peer;
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      // yoksay
    }
    peers.delete(id);
    onRemoteStream(id, null);
  }

  return {
    roomCode,
    get cameraOn() {
      return Boolean(localStream);
    },
    get localStream() {
      return localStream;
    },

    /** Odadaki uye listesine gore baglantilari ac/kapat. */
    syncPeers(memberIds) {
      if (destroyed) return;
      const wanted = new Set(memberIds.filter((id) => id && id !== selfId));
      for (const id of [...peers.keys()]) if (!wanted.has(id)) closePeer(id);
      for (const id of wanted) if (!peers.has(id)) createPeer(id);
    },

    async handleSignal(from, data) {
      if (destroyed || !data) return;
      const peer = peers.get(from) || createPeer(from);
      const { pc } = peer;
      try {
        if (data.description) {
          const offerCollision =
            data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(data.description);
          if (data.description.type === 'offer') {
            await pc.setLocalDescription();
            send(from, { description: pc.localDescription.toJSON() });
          }
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) throw err;
          }
        }
      } catch {
        // bozuk/eski sinyal: yoksay
      }
    },

    async startCamera() {
      if (localStream) return localStream;
      localStream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      for (const peer of peers.values()) addLocalTrack(peer);
      return localStream;
    },

    stopCamera() {
      if (!localStream) return;
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      for (const peer of peers.values()) {
        if (peer.sender) {
          try {
            peer.pc.removeTrack(peer.sender);
          } catch {
            // yoksay
          }
          peer.sender = null;
        }
      }
    },

    destroy() {
      this.stopCamera();
      for (const id of [...peers.keys()]) closePeer(id);
      destroyed = true;
    },
  };
}
