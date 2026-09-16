/* The Windowsill
   ------------------------------------------------------------------
   Crumbs and the swatter are DETERMINISTIC: every client derives them
   from the current 14-second wave number with a seeded PRNG, so nobody
   needs to be the authority and no writes are spent spawning things.
   Firestore only carries what it has to — each fly's position, score,
   emote and the crumbs it has eaten — at ~3 writes per second.
   ------------------------------------------------------------------ */

import { ready, db, fs, ROOM, randomName } from "./db.js";

const W = 1000, H = 640;
const WAVE_MS = 14000;
const CRUMBS = 13;
const SHADOW_AT = 9000;    // ms into the wave: shadow appears
const LAND_AT = 10600;     // ms into the wave: swatter lands
const CLEAR_AT = 11600;    // ms into the wave: swatter lifts
const SWAT_R = 118;
const WRITE_MS = 320;
const STALE_MS = 15000;

const cv = document.getElementById("arena");
const ctx = cv.getContext("2d");

// Draw in a fixed 1000×640 world; scale the backing store for sharp text.
const DPR = Math.min(window.devicePixelRatio || 1, 2);
cv.width = W * DPR;
cv.height = H * DPR;
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
const hudScore = document.getElementById("hudScore");
const hudWave = document.getElementById("hudWave");
const boardEl = document.getElementById("board");
const hiEl = document.getElementById("hiscores");
const alarmEl = document.getElementById("alarm");
const joiner = document.getElementById("joiner");
const nameBox = document.getElementById("nameBox");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");

let MODE = "demo", UID = null;
let joined = false;
let name = randomName();
nameBox.textContent = name;

/* ---------------- deterministic wave content ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const waveCache = { i: -1, crumbs: null, swat: null };

function waveData(waveIndex) {
  if (waveCache.i === waveIndex) return waveCache;
  const r = mulberry32(((waveIndex % 100000) * 9301 + 49297) % 233280);
  const crumbs = [];
  const golden = Math.floor(r() * CRUMBS);
  for (let i = 0; i < CRUMBS; i++) {
    crumbs.push({
      i,
      x: 70 + r() * (W - 140),
      y: 70 + r() * (H - 140),
      gold: i === golden,
      spin: r() * 6.283
    });
  }
  const swat = { x: 130 + r() * (W - 260), y: 120 + r() * (H - 240) };
  waveCache.i = waveIndex;
  waveCache.crumbs = crumbs;
  waveCache.swat = swat;
  return waveCache;
}

/* ---------------- local player ---------------- */

const me = {
  x: W / 2, y: H / 2, vx: 0, vy: 0,
  score: 0, splatUntil: 0, emote: "", emoteAt: 0
};

let target = { x: W / 2, y: H / 2 };
const keys = new Set();
let eaten = new Set();     // crumb indices I ate this wave
let myWave = -1;
let bestSent = 0, lastHiWrite = 0;

/* ---------------- remote players ---------------- */

const others = new Map();  // id -> {n,x,y,s,t,e,em,et, rx,ry}

/* ---------------- input ---------------- */

function toWorld(e) {
  const r = cv.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * W,
    y: ((e.clientY - r.top) / r.height) * H
  };
}

cv.addEventListener("pointermove", (e) => { if (joined) target = toWorld(e); });
cv.addEventListener("pointerdown", (e) => {
  if (!joined) return;
  cv.setPointerCapture(e.pointerId);
  target = toWorld(e);
});

addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

document.querySelectorAll("[data-emote]").forEach((b) => {
  b.addEventListener("click", () => {
    me.emote = b.dataset.emote;
    me.emoteAt = Date.now();
    push(true);
  });
});

document.getElementById("rerollBtn").addEventListener("click", () => {
  name = randomName();
  nameBox.textContent = name;
});

document.getElementById("joinBtn").addEventListener("click", () => {
  joined = true;
  joiner.hidden = true;
  me.x = 120 + Math.random() * (W - 240);
  me.y = 120 + Math.random() * (H - 240);
  target = { x: me.x, y: me.y };
  push(true);
});

/* ---------------- simulation ---------------- */

function stepFly(f, tgt, dt, wander) {
  const dx = tgt.x - f.x, dy = tgt.y - f.y;
  const d = Math.hypot(dx, dy) || 1;
  const pull = Math.min(d, 120) / 120;
  f.vx += (dx / d) * 0.9 * pull * dt;
  f.vy += (dy / d) * 0.9 * pull * dt;
  // flies do not travel in straight lines
  f.vx += (Math.random() - 0.5) * wander * dt;
  f.vy += (Math.random() - 0.5) * wander * dt;
  f.vx *= 0.92; f.vy *= 0.92;
  const sp = Math.hypot(f.vx, f.vy), max = 9.5;
  if (sp > max) { f.vx = f.vx / sp * max; f.vy = f.vy / sp * max; }
  f.x = Math.max(16, Math.min(W - 16, f.x + f.vx * dt));
  f.y = Math.max(16, Math.min(H - 16, f.y + f.vy * dt));
}

let lastFrame = performance.now();
let lastLandHandled = -1;

function update(now) {
  const dt = Math.min(2.5, (now - lastFrame) / 16.67);
  lastFrame = now;

  const t = Date.now();
  const wave = Math.floor(t / WAVE_MS);
  const into = t % WAVE_MS;
  const data = waveData(wave);

  if (wave !== myWave) {
    myWave = wave;
    eaten = new Set();
    push(true);
  }

  if (joined) {
    // keyboard nudges the target around
    let kx = 0, ky = 0;
    if (keys.has("arrowleft") || keys.has("a")) kx -= 1;
    if (keys.has("arrowright") || keys.has("d")) kx += 1;
    if (keys.has("arrowup") || keys.has("w")) ky -= 1;
    if (keys.has("arrowdown") || keys.has("s")) ky += 1;
    if (kx || ky) {
      target.x = Math.max(20, Math.min(W - 20, target.x + kx * 9 * dt));
      target.y = Math.max(20, Math.min(H - 20, target.y + ky * 9 * dt));
    }

    const stunned = t < me.splatUntil;
    stepFly(me, stunned ? { x: me.x, y: me.y + 40 } : target, dt, stunned ? 0.4 : 2.2);

    // eat
    if (!stunned) {
      const gone = globalEaten();
      for (const c of data.crumbs) {
        if (eaten.has(c.i) || gone.has(c.i)) continue;
        if (Math.hypot(c.x - me.x, c.y - me.y) < 22) {
          eaten.add(c.i);
          me.score += c.gold ? 5 : 1;
          hudScore.textContent = me.score;
          push(true);
        }
      }
    }

    // the swatter lands
    if (into >= LAND_AT && into < LAND_AT + 260 && lastLandHandled !== wave) {
      lastLandHandled = wave;
      if (Math.hypot(data.swat.x - me.x, data.swat.y - me.y) < SWAT_R) {
        me.score = Math.floor(me.score / 2);
        me.splatUntil = t + 2400;
        hudScore.textContent = me.score;
        alarmEl.classList.remove("show");
        void alarmEl.offsetWidth;
        alarmEl.classList.add("show");
        if (navigator.vibrate) navigator.vibrate(120);
        push(true);
      }
    }
  }

  bots.forEach((b) => {
    if (Math.random() < 0.02) {
      const c = data.crumbs[(Math.random() * CRUMBS) | 0];
      b.tgt = { x: c.x, y: c.y };
    }
    stepFly(b, b.tgt, dt, 2.4);
    for (const c of data.crumbs) {
      if (!b.eaten.has(c.i) && Math.hypot(c.x - b.x, c.y - b.y) < 22) {
        b.eaten.add(c.i); b.s += c.gold ? 5 : 1;
      }
    }
    if (b.wave !== wave) { b.wave = wave; b.eaten = new Set(); }
  });

  // remote interpolation
  for (const o of others.values()) {
    o.rx += (o.x - o.rx) * Math.min(1, 0.22 * dt);
    o.ry += (o.y - o.ry) * Math.min(1, 0.22 * dt);
  }

  // hud
  const secs = Math.max(0, Math.ceil((LAND_AT - into) / 1000));
  hudWave.textContent = into < LAND_AT
    ? `wave ${wave % 1000} · swat in ${secs}s`
    : `wave ${wave % 1000} · swatting`;

  draw(t, wave, into, data);
  requestAnimationFrame(update);
}

function globalEaten() {
  const s = new Set(eaten);
  for (const o of others.values()) {
    if (o.w === myWave && Array.isArray(o.e)) o.e.forEach((i) => s.add(i));
  }
  for (const b of bots) b.eaten.forEach((i) => s.add(i));
  return s;
}

/* ---------------- drawing ---------------- */

const grime = (() => {
  const r = mulberry32(7);
  return Array.from({ length: 90 }, () => ({ x: r() * W, y: r() * H, s: r() * 2.2 + 0.4 }));
})();

function draw(t, wave, into, data) {
  // glass
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#5b7b98");
  g.addColorStop(0.55, "#38546f");
  g.addColorStop(1, "#22374d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // reflection streaks
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(-200, H); ctx.lineTo(240, -80); ctx.lineTo(420, -80); ctx.lineTo(-20, H);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(360, H); ctx.lineTo(800, -80); ctx.lineTo(880, -80); ctx.lineTo(440, H);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // grime
  ctx.fillStyle = "rgba(255,255,255,.10)";
  for (const s of grime) { ctx.beginPath(); ctx.arc(s.x, s.y, s.s, 0, 6.283); ctx.fill(); }

  // crumbs
  const gone = globalEaten();
  for (const c of data.crumbs) {
    if (gone.has(c.i)) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.spin + t / 3000);
    if (c.gold) {
      const pulse = 1 + Math.sin(t / 160) * 0.12;
      ctx.scale(pulse, pulse);
      ctx.shadowColor = "#ffd75e"; ctx.shadowBlur = 22;
      ctx.fillStyle = "#ffcf3d";
      ctx.fillRect(-11, -11, 22, 22);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff1bd";
      ctx.fillRect(-11, -11, 9, 9);
    } else {
      ctx.fillStyle = "#e0c288";
      ctx.fillRect(-8, -7, 16, 14);
      ctx.fillStyle = "#c8a663";
      ctx.fillRect(-8, 2, 16, 5);
    }
    ctx.restore();
  }

  // swatter shadow / strike
  if (into >= SHADOW_AT) {
    const s = data.swat;
    if (into < LAND_AT) {
      const p = (into - SHADOW_AT) / (LAND_AT - SHADOW_AT);
      ctx.save();
      ctx.globalAlpha = 0.16 + p * 0.4;
      ctx.fillStyle = "#08111a";
      ctx.beginPath(); ctx.arc(s.x, s.y, SWAT_R * (1.9 - p * 0.9), 0, 6.283); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(200,54,47," + (0.35 + p * 0.5) + ")";
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      ctx.lineDashOffset = -t / 26;
      ctx.beginPath(); ctx.arc(s.x, s.y, SWAT_R, 0, 6.283); ctx.stroke();
      ctx.restore();
    } else if (into < CLEAR_AT) {
      drawSwatter(s.x, s.y);
    }
  }

  // flies
  for (const b of bots) drawFly(b.x, b.y, b.vx, b.vy, b.n, b.s, false, "", t);
  for (const o of others.values()) {
    if (t - (o.t || 0) > STALE_MS) continue;
    const showEmote = o.em && t - (o.et || 0) < 3200 ? o.em : "";
    drawFly(o.rx, o.ry, o.x - o.rx, o.y - o.ry, o.n, o.s, false, showEmote, t);
  }
  if (joined) {
    const em = me.emote && t - me.emoteAt < 3200 ? me.emote : "";
    drawFly(me.x, me.y, me.vx, me.vy, name, me.score, true, em, t);
    if (t < me.splatUntil) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#c8362f";
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283;
        ctx.beginPath();
        ctx.arc(me.x + Math.cos(a) * 16, me.y + Math.sin(a) * 12, 5 + (i % 3) * 2, 0, 6.283);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

function drawSwatter(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.35);
  ctx.fillStyle = "#c8362f";
  roundRect(-SWAT_R, -SWAT_R * 0.86, SWAT_R * 2, SWAT_R * 1.72, 26);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.28)";
  ctx.lineWidth = 3;
  for (let i = -SWAT_R + 16; i < SWAT_R; i += 20) {
    ctx.beginPath(); ctx.moveTo(i, -SWAT_R * 0.86); ctx.lineTo(i, SWAT_R * 0.86); ctx.stroke();
  }
  for (let j = -SWAT_R * 0.86 + 14; j < SWAT_R * 0.86; j += 20) {
    ctx.beginPath(); ctx.moveTo(-SWAT_R, j); ctx.lineTo(SWAT_R, j); ctx.stroke();
  }
  ctx.fillStyle = "#8f2520";
  ctx.fillRect(SWAT_R - 6, -14, 210, 28);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFly(x, y, vx, vy, label, score, isMe, emote, t) {
  ctx.save();
  ctx.translate(x, y);

  if (isMe) {
    ctx.strokeStyle = "rgba(232,163,23,.85)";
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, 6.283); ctx.stroke();
  }

  ctx.save();
  ctx.rotate(Math.atan2(vy, vx));
  const flap = 1 + Math.sin(t / 14 + x) * 0.5;
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = "#e9dcc0";
  ctx.beginPath(); ctx.ellipse(-2, -6 * flap, 12, 4.5, -0.5, 0, 6.283); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-2, 6 * flap, 12, 4.5, 0.5, 0, 6.283); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#17100e";
  ctx.beginPath(); ctx.ellipse(0, 0, 12, 7, 0, 0, 6.283); ctx.fill();
  ctx.fillStyle = isMe ? "#e8a317" : "#2e5fa3";
  ctx.beginPath(); ctx.ellipse(8, 0, 5.2, 4.8, 0, 0, 6.283); ctx.fill();
  ctx.restore();

  // label
  ctx.font = "700 13px Karla, sans-serif";
  ctx.textAlign = "center";
  const text = `${label} · ${score}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(10,18,26,.6)";
  roundRect(-w / 2 - 6, 18, w + 12, 19, 5); ctx.fill();
  ctx.fillStyle = isMe ? "#e8a317" : "#ede2c8";
  ctx.fillText(text, 0, 32);

  if (emote) {
    ctx.font = "700 15px Karla, sans-serif";
    const ew = ctx.measureText(emote).width;
    ctx.fillStyle = "#ede2c8";
    roundRect(-ew / 2 - 10, -50, ew + 20, 26, 9); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-6, -25); ctx.lineTo(6, -25); ctx.lineTo(0, -16);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#2a1512";
    ctx.fillText(emote, 0, -32);
  }
  ctx.restore();
}

/* ---------------- demo-mode bots ---------------- */

const bots = [];
function spawnBots() {
  for (let i = 0; i < 3; i++) {
    bots.push({
      n: randomName(), x: Math.random() * W, y: Math.random() * H,
      vx: 0, vy: 0, s: 0, eaten: new Set(), wave: -1,
      tgt: { x: Math.random() * W, y: Math.random() * H }
    });
  }
}

/* ---------------- networking ---------------- */

let lastWrite = 0, lastSent = { x: -1, y: -1, s: -1 };

async function push(force) {
  if (MODE !== "live" || !joined) return;
  const t = Date.now();
  const moved = Math.hypot(me.x - lastSent.x, me.y - lastSent.y) > 2;
  if (!force && t - lastWrite < WRITE_MS) return;
  if (!force && !moved && me.score === lastSent.s && t - lastWrite < 5000) return;

  lastWrite = t;
  lastSent = { x: me.x, y: me.y, s: me.score };
  try {
    const { doc, setDoc } = fs;
    await setDoc(doc(db(), "rooms", ROOM, "players", UID), {
      n: name,
      x: Math.round(me.x), y: Math.round(me.y),
      s: me.score, t, w: myWave,
      e: [...eaten],
      em: me.emote || "", et: me.emoteAt || 0
    });
  } catch (err) {
    setStatus(false, "Offline — your fly is only visible to you.");
  }

  // personal best, written sparingly
  if (me.score > bestSent && me.score > 0 && t - lastHiWrite > 15000) {
    bestSent = me.score; lastHiWrite = t;
    try {
      const { doc, setDoc } = fs;
      await setDoc(doc(db(), "rooms", ROOM, "hiscores", UID), { n: name, s: me.score, t });
    } catch (_) { /* fine */ }
  }
}

setInterval(() => push(false), WRITE_MS);

function setStatus(ok, text) {
  statusEl.classList.toggle("offline", !ok);
  statusText.textContent = text;
}

/* ---------------- leaderboards ---------------- */

function renderBoard() {
  const rows = [];
  if (joined) rows.push({ id: "me", n: name, s: me.score, me: true });
  const t = Date.now();
  for (const [id, o] of others) {
    if (t - (o.t || 0) > STALE_MS) continue;
    rows.push({ id, n: o.n || "a fly", s: o.s || 0 });
  }
  for (const b of bots) rows.push({ id: b.n, n: b.n + " (bot)", s: b.s });

  rows.sort((a, b) => b.s - a.s);
  document.getElementById("liveCount").textContent = String(rows.length);

  boardEl.innerHTML = rows.length
    ? rows.slice(0, 10).map((r, i) =>
        `<li class="${r.me ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who">${esc(r.n)}</span><span class="pts">${r.s}</span></li>`
      ).join("")
    : `<li class="empty">Nobody yet. Be the first fly.</li>`;
}
setInterval(renderBoard, 600);

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/* ---------------- boot ---------------- */

ready.then(({ demo, uid }) => {
  UID = uid;
  MODE = demo ? "demo" : "live";

  if (demo) {
    spawnBots();
    setStatus(false, "Demo mode — add a Firebase config to play with other people.");
    document.getElementById("joinNote").textContent =
      "Running in demo mode, so you will be sharing the window with three bots.";
  } else {
    setStatus(true, "Connected. Everyone here is on the same window.");
    const { collection, onSnapshot, doc, deleteDoc } = fs;

    onSnapshot(collection(db(), "rooms", ROOM, "players"), (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.doc.id === UID) return;
        if (ch.type === "removed") { others.delete(ch.doc.id); return; }
        const d = ch.doc.data();
        const prev = others.get(ch.doc.id);
        others.set(ch.doc.id, {
          ...d,
          rx: prev ? prev.rx : d.x,
          ry: prev ? prev.ry : d.y
        });
      });
    }, () => setStatus(false, "Lost the connection. Refresh to rejoin."));

    onSnapshot(collection(db(), "rooms", ROOM, "hiscores"), (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push(d.data()));
      rows.sort((a, b) => (b.s || 0) - (a.s || 0));
      hiEl.innerHTML = rows.length
        ? rows.slice(0, 8).map((r, i) =>
            `<li><span class="rank">${i + 1}</span><span class="who">${esc(r.n || "a fly")}</span><span class="pts">${r.s || 0}</span></li>`
          ).join("")
        : `<li class="empty">No records yet.</li>`;
    });

    const leave = () => {
      try { deleteDoc(doc(db(), "rooms", ROOM, "players", UID)); } catch (_) {}
    };
    addEventListener("pagehide", leave);
    addEventListener("beforeunload", leave);
  }

  requestAnimationFrame(update);
});
