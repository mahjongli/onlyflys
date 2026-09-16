/* net.js — peer-to-peer transport for The Windowsill
   ------------------------------------------------------------------
   Firestore is a database, not a game transport. Sending positions
   through it costs a write per tick per player and arrives too slowly
   to look smooth.

   So Firestore now does one job: introducing people. Two documents per
   pair (an offer and an answer) and then the browsers talk directly to
   each other over WebRTC data channels at 15 Hz, for free, forever.

   Per player, per session, the entire Firestore cost is roughly:
     1 write   join the room
     ~2 writes per peer already present (offer/answer + tidy up)
     1 write   every 5 minutes, so long sessions aren't reaped
     1 write   leave the room
   ------------------------------------------------------------------ */

import { ready, db, fs, ROOM } from "./db.js";

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ]
};

const MAX_PEERS = 7;          // beyond this a full mesh stops being sensible
const STALE_MS = 12 * 60000;  // presence docs older than this are fair game
const HEARTBEAT_MS = 5 * 60000;
const GATHER_MS = 2500;       // how long to wait for ICE before giving up

export const net = {
  mode: "offline",   // "offline" | "p2p"
  uid: null,
  peers: new Map(),  // id -> { id, name, state, evt, pc }
  onPeerJoin: () => {},
  onPeerLeave: () => {},
  onState: () => {},
  onEvent: () => {},
  onStatus: () => {},

  sendState(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.peers.values()) {
      if (p.state && p.state.readyState === "open") {
        try { p.state.send(s); } catch (_) {}
      }
    }
  },

  sendEvent(obj, onlyTo) {
    const s = JSON.stringify(obj);
    for (const p of this.peers.values()) {
      if (onlyTo && p.id !== onlyTo) continue;
      if (p.evt && p.evt.readyState === "open") {
        try { p.evt.send(s); } catch (_) {}
      }
    }
  },

  count() {
    let n = 0;
    for (const p of this.peers.values()) if (p.state && p.state.readyState === "open") n++;
    return n;
  }
};

let myName = "a fly";
let leaving = false;

export async function joinRoom(name) {
  myName = name;
  const { demo, uid } = await ready;
  net.uid = uid;
  if (demo) {
    net.mode = "offline";
    net.onStatus("offline", "No Firebase config — playing locally with bots.");
    return;
  }

  const { doc, setDoc, deleteDoc, collection, onSnapshot, updateDoc } = fs;
  const D = db();
  const peersCol = collection(D, "rooms", ROOM, "peers");
  const myDoc = doc(D, "rooms", ROOM, "peers", uid);

  try {
    await setDoc(myDoc, { n: name, t: Date.now() });
  } catch (err) {
    net.mode = "offline";
    net.onStatus("offline", "Couldn't reach the room. Playing locally.");
    return;
  }

  net.mode = "p2p";
  net.onStatus("waiting", "In the room. Looking for other flies…");

  // Keep the presence doc from being reaped during a long session.
  setInterval(() => {
    if (!leaving) updateDoc(myDoc, { t: Date.now() }).catch(() => {});
  }, HEARTBEAT_MS);

  // Who else is here? One read per change, and changes are rare.
  onSnapshot(peersCol, (snap) => {
    const now = Date.now();
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (id === uid) return;

      if (ch.type === "removed") { dropPeer(id); return; }

      const d = ch.doc.data();
      if (now - (d.t || 0) > STALE_MS) {
        // A browser that crashed and never said goodbye. Tidy it away.
        deleteDoc(ch.doc.ref).catch(() => {});
        return;
      }
      if (net.peers.has(id)) {
        const p = net.peers.get(id);
        if (d.n) p.name = d.n;
        return;
      }
      if (net.peers.size >= MAX_PEERS) return;

      // Only one side offers, or both would call at once.
      if (uid < id) offerTo(id, d.n || "a fly");
      else net.peers.set(id, blankPeer(id, d.n || "a fly"));
    });
    reportStatus();
  }, () => net.onStatus("offline", "Lost the room. Refresh to rejoin."));

  // My mailbox. Only I can read it, and only the sender can write to it.
  onSnapshot(collection(D, "rooms", ROOM, "peers", uid, "inbox"), (snap) => {
    snap.docChanges().forEach(async (ch) => {
      if (ch.type === "removed") return;
      const from = ch.doc.id;
      const m = ch.doc.data();
      try {
        if (m.k === "offer") await answerTo(from, m);
        else if (m.k === "answer") await takeAnswer(from, m);
      } catch (err) {
        console.warn("[net] handshake failed with", from, err);
      }
      deleteDoc(ch.doc.ref).catch(() => {});
    });
  });

  const bye = () => {
    leaving = true;
    for (const p of net.peers.values()) { try { p.pc.close(); } catch (_) {} }
    try { deleteDoc(myDoc); } catch (_) {}
  };
  addEventListener("pagehide", bye);
  addEventListener("beforeunload", bye);
}

/* ---------------- handshake ---------------- */

function blankPeer(id, name) {
  return { id, name, pc: null, state: null, evt: null, pending: true };
}

function newConnection(id) {
  const pc = new RTCPeerConnection(ICE);
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) dropPeer(id);
  };
  return pc;
}

function wire(id, pc, state, evt) {
  const p = net.peers.get(id) || blankPeer(id, "a fly");
  p.pc = pc;
  if (state) p.state = state;
  if (evt) p.evt = evt;
  net.peers.set(id, p);

  if (state) {
    state.onmessage = (e) => {
      try { net.onState(id, JSON.parse(e.data)); } catch (_) {}
    };
    state.onopen = () => {
      p.pending = false;
      net.onPeerJoin(id, p.name);
      net.sendEvent({ k: "hello", n: myName }, id);
      reportStatus();
    };
    state.onclose = () => dropPeer(id);
  }
  if (evt) {
    evt.onmessage = (e) => {
      try { net.onEvent(id, JSON.parse(e.data)); } catch (_) {}
    };
  }
}

async function offerTo(id, name) {
  const pc = newConnection(id);
  const state = pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 });
  const evt = pc.createDataChannel("evt", { ordered: true });
  net.peers.set(id, { ...blankPeer(id, name), pc });
  wire(id, pc, state, evt);

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  await post(id, { k: "offer", sdp: JSON.stringify(pc.localDescription) });
}

async function answerTo(from, m) {
  const pc = newConnection(from);
  const existing = net.peers.get(from);
  net.peers.set(from, { ...blankPeer(from, existing ? existing.name : "a fly"), pc });

  pc.ondatachannel = (e) => {
    if (e.channel.label === "state") wire(from, pc, e.channel, null);
    else wire(from, pc, null, e.channel);
  };

  await pc.setRemoteDescription(JSON.parse(m.sdp));
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  await post(from, { k: "answer", sdp: JSON.stringify(pc.localDescription) });
}

async function takeAnswer(from, m) {
  const p = net.peers.get(from);
  if (!p || !p.pc || p.pc.signalingState === "stable") return;
  await p.pc.setRemoteDescription(JSON.parse(m.sdp));
}

// Non-trickle ICE: wait for every candidate, then send one document.
// Trickling would cost a Firestore write per candidate.
function gathered(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

async function post(to, payload) {
  const { doc, setDoc } = fs;
  await setDoc(doc(db(), "rooms", ROOM, "peers", to, "inbox", net.uid), {
    ...payload, t: Date.now()
  });
}

function dropPeer(id) {
  const p = net.peers.get(id);
  if (!p) return;
  try { p.pc && p.pc.close(); } catch (_) {}
  net.peers.delete(id);
  net.onPeerLeave(id);
  reportStatus();
}

function reportStatus() {
  if (net.mode !== "p2p") return;
  const n = net.count();
  const pending = [...net.peers.values()].filter((p) => p.pending).length;
  if (n > 0) net.onStatus("p2p", `Connected directly to ${n} fl${n === 1 ? "y" : "ies"}.`);
  else if (pending > 0) net.onStatus("waiting", "Shaking hands with another fly…");
  else net.onStatus("waiting", "In the room, nobody else here yet.");
}

/* One-off record keeping. Called at most once a minute. */
export async function saveScore(name, score) {
  const { demo, uid } = await ready;
  if (demo || !score) return;
  try {
    const { doc, setDoc } = fs;
    await setDoc(doc(db(), "rooms", ROOM, "hiscores", uid), { n: name, s: score, t: Date.now() });
  } catch (_) {}
}

export function watchScores(cb) {
  ready.then(({ demo }) => {
    if (demo) return;
    const { collection, onSnapshot, query, orderBy, limit } = fs;
    const q = query(
      collection(db(), "rooms", ROOM, "hiscores"),
      orderBy("s", "desc"),
      limit(8)
    );
    onSnapshot(q, (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push(d.data()));
      cb(rows);
    }, () => {});
  });
}
