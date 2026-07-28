/* Peer-to-peer transport for online play.

   There is no server anywhere in this project, so the two browsers connect
   directly over WebRTC. The one thing a server normally does is pass the
   initial connection descriptions between peers ("signalling") — here the
   players do that themselves by copying one code each. Once that is done the
   data channel is direct, and nothing else touches a third party.

   A public STUN server is listed so peers on different networks can discover
   their public addresses. It only helps with discovery; no game data flows
   through it. On the same Wi-Fi the connection works without it. */

const Net = {
  pc: null,
  channel: null,
  role: null,          // 'host' | 'guest'
  open: false,
  handlers: {},

  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  },

  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  },

  emit(event, payload) {
    if (this.handlers[event]) this.handlers[event](payload);
  },

  /* ---------- Connection ---------- */

  reset() {
    if (this.channel) { try { this.channel.close(); } catch { /* already gone */ } }
    if (this.pc) { try { this.pc.close(); } catch { /* already gone */ } }
    this.pc = null;
    this.channel = null;
    this.open = false;
    this.role = null;
  },

  bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.open = true;
      this.emit('open');
    };
    channel.onclose = () => {
      this.open = false;
      this.emit('close');
    };
    channel.onerror = () => {
      this.open = false;
      this.emit('close');
    };
    channel.onmessage = (event) => {
      try {
        this.emit('message', JSON.parse(event.data));
      } catch {
        /* ignore anything that is not our JSON */
      }
    };
  },

  watch() {
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.open = false;
        this.emit('close');
      }
    };
  },

  /* Host: build the invite code. */
  async createInvite(payload) {
    this.reset();
    this.role = 'host';
    this.pc = new RTCPeerConnection(this.config);
    this.watch();

    // ordered:false / maxRetransmits:0 — stale car positions are worthless,
    // so never hold newer ones up waiting for a lost packet
    this.bindChannel(this.pc.createDataChannel('race', { ordered: false, maxRetransmits: 0 }));

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.gathered();

    return pack({ ...payload, sdp: this.pc.localDescription.sdp, type: 'offer' });
  },

  /* Host: finish the handshake with the reply code. */
  async acceptReply(code) {
    const data = await unpack(code);
    if (!data || data.type !== 'answer') throw new Error('That is not a reply code');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    return data;
  },

  /* Guest: consume an invite and produce the reply code. */
  async joinWithInvite(code, payload) {
    const data = await unpack(code);
    if (!data || data.type !== 'offer') throw new Error('That is not an invite code');

    this.reset();
    this.role = 'guest';
    this.pc = new RTCPeerConnection(this.config);
    this.watch();
    this.pc.ondatachannel = (event) => this.bindChannel(event.channel);

    await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.gathered();

    return {
      invite: data,
      code: pack({ ...payload, sdp: this.pc.localDescription.sdp, type: 'answer' }),
    };
  },

  /* Wait for ICE candidates, but never hang on a slow relay. */
  gathered() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 2500);
    });
  },

  send(message) {
    if (!this.open) return false;
    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  },
};

/* ---------- Code packing ----------
   Raw session descriptions are several kilobytes of text. Deflate them where
   the browser supports it so the code a player has to copy stays manageable. */

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* Deflate is async, so packing returns a promise-like value only when needed.
   The caller always awaits, so returning a promise from both paths is fine. */
async function pack(object) {
  const bytes = new TextEncoder().encode(JSON.stringify(object));
  if (typeof CompressionStream === 'undefined') return `R${toBase64(bytes)}`;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return `Z${toBase64(packed)}`;
  } catch {
    return `R${toBase64(bytes)}`;
  }
}

async function unpack(code) {
  const trimmed = (code || '').replace(/\s+/g, '');
  if (trimmed.length < 2) return null;
  const body = fromBase64(trimmed.slice(1));

  if (trimmed[0] === 'R') return JSON.parse(new TextDecoder().decode(body));
  if (trimmed[0] !== 'Z') return null;

  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const plain = new Uint8Array(await new Response(stream).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(plain));
}
