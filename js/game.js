/* The Windowsill v2
   ------------------------------------------------------------------
   Positions travel peer-to-peer over WebRTC at 15 Hz (see net.js) and
   are rendered 120 ms in the past, interpolated between the two
   snapshots either side of that moment. That's what makes other flies
   glide instead of teleport: we always have a real sample ahead of the
   one being drawn, so nothing has to be guessed.

   Crumbs and the swatter are still deterministic per wave, so nothing
   has to be sent to spawn them.

   The loop: grab crumbs → carry them (slow, stealable, swattable) →
   bank them at the jam jar → spend on upgrades or hoard for the board.
   ------------------------------------------------------------------ */

import { randomName } from "./db.js";
import { net, joinRoom, saveScore, watchScores } from "./net.js";

/* ---------------- constants ---------------- */

const W = 1000, H = 640;
const WAVE_MS = 18000;
const CRUMBS = 14;
const SHADOW_AT = 12000, LAND_AT = 13800, CLEAR_AT = 14900;
const SWAT_R = 118;
const JAR_R = 54;

const SEND_MS = 66;        // 15 Hz over the data channel
const INTERP_MS = 120;     // render remote flies this far in the past
const DASH_MS = 320;
const RAM_R = 34;
const IMMUNE_MS = 1600;
const LOOSE_LIFE = 26000;

const UPGRADES = {
  wing: { label: "Faster wings", costs: [6, 12, 24], blurb: "Higher top speed." },
  gut:  { label: "Bigger gut",   costs: [8, 16, 32], blurb: "Carry more before you slow down." },
  dive: { label: "Sharper dive", costs: [6, 12, 24], blurb: "Shorter cooldown, harder hit." }
};

/* ---------------- dom ---------------- */

const cv = document.getElementById("arena");
const ctx = cv.getContext("2d");
const DPR = Math.min(window.devicePixelRatio || 1, 2);
cv.width = W * DPR; cv.height = H * DPR;
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

const el = (id) => document.getElementById(id);
const hudScore = el("hudScore"), hudWallet = el("hudWallet"), hudCarry = el("hudCarry");
const hudWave = el("hudWave"), diveBtn = el("diveBtn"), diveFill = el("diveFill");
const boardEl = el("board"), hiEl = el("hiscores"), shopEl = el("shop");
const alarmEl = el("alarm"), toastEl = el("toast");
const joiner = el("joiner"), nameBox = el("nameBox");
const statusEl = el("status"), statusText = el("statusText");

/* ---------------- deterministic wave content ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = { i: -1 };
function waveData(wave) {
  if (cache.i === wave) return cache;
  const r = mulberry32(((wave % 100000) * 9301 + 49297) % 233280);
  const jar = { x: 140 + r() * (W - 280), y: 130 + r() * (H - 260) };
  const crumbs = [];
  const gold = Math.floor(r() * CRUMBS);
  for (let i = 0; i < CRUMBS; i++) {
    let x, y, tries = 0;
    do {
      x = 60 + r() * (W - 120);
      y = 60 + r() * (H - 120);
      tries++;
    } while (Math.hypot(x - jar.x, y - jar.y) < JAR_R + 50 && tries < 6);
    crumbs.push({ id: `w${wave}-${i}`, x, y, gold: i === gold, spin: r() * 6.283 });
  }
  cache.i = wave;
  cache.jar = jar;
  cache.crumbs = crumbs;
  cache.swat = { x: 130 + r() * (W - 260), y: 120 + r() * (H - 240) };
  return cache;
}

/* ---------------- state ---------------- */

let name = randomName();
nameBox.textContent = name;
let joined = false;

const me = {
  x: W / 2, y: H / 2, vx: 0, vy: 0,
  carried: 0, banked: 0, wallet: 0,
  upg: { wing: 0, gut: 0, dive: 0 },
  splatUntil: 0, immuneUntil: 0, dashUntil: 0, dashReadyAt: 0,
  dirx: 1, diry: 0, emote: "", emoteAt: 0
};

let target = { x: W / 2, y: H / 2 };
const keys = new Set();

const flies = new Map();      // peer id -> remote fly
const taken = new Set();      // crumb ids consumed (wave + loose)
const loose = new Map();      // id -> { x, y, born }
let looseSeq = 0;
let myWave = -1;
let lastLandHandled = -1;
let bestSaved = 0, lastSave = 0;

/* ---------------- helpers ---------------- */

function maxSpeed() {
  const cap = 18 + me.upg.gut * 12;
  const penalty = Math.min(0.5, (me.carried / cap) * 0.5);
  return 9.4 * (1 + 0.13 * me.upg.wing) * (1 - penalty);
}
function dashCooldown() { return Math.max(1100, 2600 - me.upg.dive * 500); }
function dashPower() { return 22 + me.upg.dive * 3; }

function toast(msg, colour) {
  toastEl.textContent = msg;
  toastEl.style.color = colour || "var(--mustard)";
  toastEl.classList.remove("show");
  void toastEl.offsetWidth;
  toastEl.classList.add("show");
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/* ---------------- input ---------------- */

function toWorld(e) {
  const r = cv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}
cv.addEventListener("pointermove", (e) => { if (joined) target = toWorld(e); });
cv.addEventListener("pointerdown", (e) => {
  if (!joined) return;
  cv.setPointerCapture(e.pointerId);
  target = toWorld(e);
});
cv.addEventListener("dblclick", (e) => { e.preventDefault(); dive(); });

addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
  if (e.key === " ") dive();
  keys.add(e.key.toLowerCase());
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
diveBtn.addEventListener("click", dive);

document.querySelectorAll("[data-emote]").forEach((b) => {
  b.addEventListener("click", () => {
    me.emote = b.dataset.emote;
    me.emoteAt = Date.now();
  });
});

el("rerollBtn").addEventListener("click", () => { name = randomName(); nameBox.textContent = name; });

el("joinBtn").addEventListener("click", async () => {
  joined = true;
  joiner.hidden = true;
  const d = waveData(Math.floor(Date.now() / WAVE_MS));
  me.x = d.jar.x + (Math.random() - .5) * 200;
  me.y = d.jar.y + (Math.random() - .5) * 160;
  target = { x: me.x, y: me.y };
  await joinRoom(name);
});

function dive() {
  const t = Date.now();
  if (!joined || t < me.dashReadyAt || t < me.splatUntil) return;
  const dx = target.x - me.x, dy = target.y - me.y;
  const d = Math.hypot(dx, dy) || 1;
  me.dirx = dx / d; me.diry = dy / d;
  me.dashUntil = t + DASH_MS;
  me.dashReadyAt = t + DASH_MS + dashCooldown();
  me.vx = me.dirx * dashPower();
  me.vy = me.diry * dashPower();
}

/* ---------------- shop ---------------- */

function renderShop() {
  shopEl.innerHTML = Object.entries(UPGRADES).map(([k, u]) => {
    const lvl = me.upg[k];
    const maxed = lvl >= u.costs.length;
    const cost = maxed ? 0 : u.costs[lvl];
    const afford = me.wallet >= cost;
    return `<div class="buy">
      <div>
        <div class="buy-name">${u.label} <span class="lvl">${"●".repeat(lvl)}${"○".repeat(u.costs.length - lvl)}</span></div>
        <div class="buy-blurb">${u.blurb}</div>
      </div>
      <button type="button" data-buy="${k}" ${maxed || !afford ? "disabled" : ""}>
        ${maxed ? "maxed" : cost + " 🍞"}
      </button>
    </div>`;
  }).join("");
}

shopEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-buy]");
  if (!b) return;
  const k = b.dataset.buy, u = UPGRADES[k], lvl = me.upg[k];
  if (lvl >= u.costs.length || me.wallet < u.costs[lvl]) return;
  me.wallet -= u.costs[lvl];
  me.upg[k]++;
  toast(`${u.label} upgraded`, "var(--avocado)");
  renderShop();
  updateHud();
});

/* ---------------- networking glue ---------------- */

net.onStatus = (kind, text) => {
  statusEl.classList.toggle("offline", kind !== "p2p");
  statusText.textContent = text;
};

net.onPeerJoin = (id, peerName) => {
  if (!flies.has(id)) flies.set(id, blankFly(peerName));
  else flies.get(id).name = peerName;
  // Bring the newcomer up to date on what's already been eaten.
  net.sendEvent({
    k: "sync",
    n: name,
    taken: [...taken].filter((x) => x.startsWith(`w${myWave}-`)),
    loose: [...loose.entries()].map(([lid, c]) => ({ id: lid, x: Math.round(c.x), y: Math.round(c.y) }))
  }, id);
};

net.onPeerLeave = (id) => flies.delete(id);

function blankFly(n) {
  return { name: n || "a fly", buf: [], x: W / 2, y: H / 2, vx: 0, vy: 0,
           carried: 0, banked: 0, dash: 0, emote: "", emoteAt: 0 };
}

net.onState = (id, s) => {
  let f = flies.get(id);
  if (!f) { f = blankFly(); flies.set(id, f); }
  f.carried = s.c || 0;
  f.banked = s.b || 0;
  f.dash = s.d || 0;
  f.emote = s.e || "";
  f.emoteAt = s.et || 0;
  f.buf.push({ r: performance.now(), x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0 });
  if (f.buf.length > 16) f.buf.shift();
};

net.onEvent = (id, m) => {
  const f = flies.get(id);
  switch (m.k) {
    case "hello":
      if (f) f.name = m.n;
      else flies.set(id, blankFly(m.n));
      break;
    case "sync":
      if (f && m.n) f.name = m.n;
      (m.taken || []).forEach((x) => taken.add(x));
      (m.loose || []).forEach((c) => {
        if (!taken.has(c.id) && !loose.has(c.id)) loose.set(c.id, { x: c.x, y: c.y, born: Date.now() });
      });
      break;
    case "take":
      taken.add(m.id);
      loose.delete(m.id);
      break;
    case "drop":
      (m.crumbs || []).forEach((c) => {
        if (!taken.has(c.id)) loose.set(c.id, { x: c.x, y: c.y, born: Date.now() });
      });
      break;
    case "ram":
      takeHit(f ? f.name : "someone", m.dx || 0, m.dy || 0);
      break;
  }
};

function takeHit(byName, dx, dy) {
  const t = Date.now();
  me.vx += dx * 13; me.vy += dy * 13;
  if (t < me.immuneUntil || me.carried <= 0) return;
  me.immuneUntil = t + IMMUNE_MS;
  const drop = Math.max(1, Math.ceil(me.carried * 0.6));
  me.carried -= drop;
  const crumbs = [];
  for (let i = 0; i < drop; i++) {
    const a = Math.random() * 6.283, r = 18 + Math.random() * 46;
    const id = `${net.uid || "me"}-${looseSeq++}`;
    const c = {
      id,
      x: Math.max(24, Math.min(W - 24, me.x + Math.cos(a) * r)),
      y: Math.max(24, Math.min(H - 24, me.y + Math.sin(a) * r))
    };
    crumbs.push(c);
    loose.set(id, { x: c.x, y: c.y, born: t });
  }
  net.sendEvent({ k: "drop", crumbs });
  toast(`${byName} knocked ${drop} out of you`, "var(--splat)");
  updateHud();
}

/* ---------------- simulation ---------------- */

function stepFly(f, tgt, dt, wander, cap) {
  const dx = tgt.x - f.x, dy = tgt.y - f.y;
  const d = Math.hypot(dx, dy) || 1;
  const pull = Math.min(d, 120) / 120;
  f.vx += (dx / d) * 0.95 * pull * dt;
  f.vy += (dy / d) * 0.95 * pull * dt;
  f.vx += (Math.random() - 0.5) * wander * dt;
  f.vy += (Math.random() - 0.5) * wander * dt;
  f.vx *= 0.92; f.vy *= 0.92;
  const sp = Math.hypot(f.vx, f.vy);
  if (sp > cap) { f.vx = f.vx / sp * cap; f.vy = f.vy / sp * cap; }
  f.x = Math.max(16, Math.min(W - 16, f.x + f.vx * dt));
  f.y = Math.max(16, Math.min(H - 16, f.y + f.vy * dt));
}

let lastFrame = performance.now();
let lastSend = 0;
let bankGlow = 0;

function update(now) {
  const dt = Math.min(2.5, (now - lastFrame) / 16.67);
  lastFrame = now;
  const t = Date.now();
  const wave = Math.floor(t / WAVE_MS);
  const into = t % WAVE_MS;
  const data = waveData(wave);

  if (wave !== myWave) {
    myWave = wave;
    for (const id of [...taken]) if (id.startsWith("w") && !id.startsWith(`w${wave}-`)) taken.delete(id);
  }

  for (const [id, c] of loose) if (t - c.born > LOOSE_LIFE) loose.delete(id);

  if (joined) {
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
    const dashing = t < me.dashUntil;

    if (dashing) {
      me.vx += me.dirx * 3.2 * dt;
      me.vy += me.diry * 3.2 * dt;
      me.vx *= 0.95; me.vy *= 0.95;
      const sp = Math.hypot(me.vx, me.vy), cap = dashPower();
      if (sp > cap) { me.vx = me.vx / sp * cap; me.vy = me.vy / sp * cap; }
      me.x = Math.max(16, Math.min(W - 16, me.x + me.vx * dt));
      me.y = Math.max(16, Math.min(H - 16, me.y + me.vy * dt));
      checkRam(t);
    } else {
      stepFly(me, stunned ? { x: me.x, y: me.y + 40 } : target, dt, stunned ? 0.4 : 2.2,
              stunned ? 3 : maxSpeed());
    }

    if (!stunned) {
      for (const c of data.crumbs) {
        if (taken.has(c.id)) continue;
        if (Math.hypot(c.x - me.x, c.y - me.y) < 24) {
          taken.add(c.id);
          me.carried += c.gold ? 5 : 1;
          net.sendEvent({ k: "take", id: c.id });
          updateHud();
        }
      }
      for (const [id, c] of loose) {
        if (Math.hypot(c.x - me.x, c.y - me.y) < 24) {
          loose.delete(id); taken.add(id);
          me.carried += 1;
          net.sendEvent({ k: "take", id });
          updateHud();
        }
      }
      if (me.carried > 0 && Math.hypot(data.jar.x - me.x, data.jar.y - me.y) < JAR_R) {
        me.banked += me.carried;
        me.wallet += me.carried;
        toast(`Banked ${me.carried}`, "var(--mustard)");
        me.carried = 0;
        bankGlow = 1;
        updateHud(); renderShop();
        maybeSave(t);
      }
    }

    if (into >= LAND_AT && into < LAND_AT + 260 && lastLandHandled !== wave) {
      lastLandHandled = wave;
      if (Math.hypot(data.swat.x - me.x, data.swat.y - me.y) < SWAT_R) {
        const lost = me.carried;
        me.carried = 0;
        me.splatUntil = t + 2200;
        me.immuneUntil = t + 2600;
        alarmEl.classList.remove("show"); void alarmEl.offsetWidth; alarmEl.classList.add("show");
        if (lost) toast(`Lost ${lost} crumbs under the swatter`, "var(--splat)");
        if (navigator.vibrate) navigator.vibrate(120);
        updateHud();
      }
    }

    if (now - lastSend > SEND_MS) {
      lastSend = now;
      net.sendState({
        x: Math.round(me.x), y: Math.round(me.y),
        vx: +me.vx.toFixed(1), vy: +me.vy.toFixed(1),
        c: me.carried, b: me.banked,
        d: t < me.dashUntil ? 1 : 0,
        e: me.emote && t - me.emoteAt < 3200 ? me.emote : "",
        et: me.emoteAt
      });
    }
  }

  stepBots(dt, t, wave, data);
  interpolate(now);
  bankGlow *= 0.94;

  const secs = Math.max(0, Math.ceil((LAND_AT - into) / 1000));
  hudWave.textContent = into < LAND_AT ? `swat in ${secs}s` : "swatting";

  const cd = Math.max(0, me.dashReadyAt - t);
  const full = DASH_MS + dashCooldown();
  diveFill.style.width = `${Math.round(100 - (cd / full) * 100)}%`;
  diveBtn.classList.toggle("ready", cd === 0);

  draw(t, into, data);
  requestAnimationFrame(update);
}

function checkRam(t) {
  for (const [id, f] of flies) {
    if (Math.hypot(f.x - me.x, f.y - me.y) < RAM_R) {
      if (f.lastRam && t - f.lastRam < 900) continue;
      f.lastRam = t;
      const d = Math.hypot(me.vx, me.vy) || 1;
      net.sendEvent({ k: "ram", dx: me.vx / d, dy: me.vy / d }, id);
      me.vx *= -0.35; me.vy *= -0.35;
      toast(`Dived into ${f.name}`, "var(--avocado)");
    }
  }
  for (const b of bots) {
    if (Math.hypot(b.x - me.x, b.y - me.y) < RAM_R && b.carried > 0 && t > b.immuneUntil) {
      b.immuneUntil = t + IMMUNE_MS;
      const drop = Math.max(1, Math.ceil(b.carried * 0.6));
      b.carried -= drop;
      for (let i = 0; i < drop; i++) {
        const a = Math.random() * 6.283, r = 18 + Math.random() * 46;
        const id2 = `bot-${looseSeq++}`;
        loose.set(id2, { x: b.x + Math.cos(a) * r, y: b.y + Math.sin(a) * r, born: t });
      }
      me.vx *= -0.35; me.vy *= -0.35;
      toast(`Dived into ${b.name}`, "var(--avocado)");
    }
  }
}

/* ---------------- interpolation ----------------
   Draw every remote fly 120 ms behind the newest sample we hold, so
   there is always a sample on both sides of the moment being drawn and
   we can move smoothly between them instead of snapping to each packet.
*/
function interpolate(now) {
  const rt = now - INTERP_MS;
  for (const f of flies.values()) {
    const b = f.buf;
    if (!b.length) continue;
    while (b.length > 2 && b[1].r < rt - 400) b.shift();

    if (rt <= b[0].r) { f.x = b[0].x; f.y = b[0].y; f.vx = b[0].vx; f.vy = b[0].vy; continue; }

    let a = null, c = null;
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].r <= rt && rt <= b[i + 1].r) { a = b[i]; c = b[i + 1]; break; }
    }
    if (a && c) {
      const k = (rt - a.r) / Math.max(1, c.r - a.r);
      const nx = a.x + (c.x - a.x) * k;
      const ny = a.y + (c.y - a.y) * k;
      // A light low-pass on top of the lerp: packets don't arrive on a
      // perfect cadence, and without this the varying step between
      // samples shows up as a faint stutter.
      f.x += (nx - f.x) * 0.45;
      f.y += (ny - f.y) * 0.45;
      f.vx = a.vx + (c.vx - a.vx) * k;
      f.vy = a.vy + (c.vy - a.vy) * k;
    } else {
      // No newer sample yet: coast on last known velocity, briefly.
      const last = b[b.length - 1];
      const ahead = Math.min(220, rt - last.r) / 16.67;
      f.x = last.x + last.vx * ahead;
      f.y = last.y + last.vy * ahead;
      f.vx = last.vx; f.vy = last.vy;
    }
  }
}

/* ---------------- bots (offline mode only) ---------------- */

const bots = [];
function spawnBots() {
  for (let i = 0; i < 3; i++) {
    bots.push({
      name: randomName(), x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0,
      carried: 0, banked: 0, immuneUntil: 0, mood: "hunt",
      tgt: { x: Math.random() * W, y: Math.random() * H }, emote: "", emoteAt: 0
    });
  }
}

function stepBots(dt, t, wave, data) {
  for (const b of bots) {
    if (b.carried >= 6 || (b.carried > 0 && Math.random() < 0.002)) b.mood = "bank";
    if (b.carried === 0) b.mood = "hunt";
    if (b.mood === "hunt" && Math.random() < 0.02) {
      let best = null, bd = 1e9;
      for (const c of data.crumbs) {
        if (taken.has(c.id)) continue;
        const d = Math.hypot(c.x - b.x, c.y - b.y);
        if (d < bd) { bd = d; best = c; }
      }
      for (const [, c] of loose) {
        const d = Math.hypot(c.x - b.x, c.y - b.y);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) b.tgt = { x: best.x, y: best.y };
    }
    if (b.mood === "bank") b.tgt = data.jar;

    // bots avoid the swatter, mostly
    const into = t % WAVE_MS;
    if (into > SHADOW_AT && into < LAND_AT && Math.hypot(data.swat.x - b.x, data.swat.y - b.y) < SWAT_R + 40) {
      b.tgt = { x: W - data.swat.x, y: H - data.swat.y };
    }

    stepFly(b, b.tgt, dt, 2.4, 7.6);

    for (const c of data.crumbs) {
      if (!taken.has(c.id) && Math.hypot(c.x - b.x, c.y - b.y) < 24) {
        taken.add(c.id); b.carried += c.gold ? 5 : 1;
      }
    }
    for (const [id, c] of loose) {
      if (Math.hypot(c.x - b.x, c.y - b.y) < 24) { loose.delete(id); b.carried += 1; }
    }
    if (b.carried > 0 && Math.hypot(data.jar.x - b.x, data.jar.y - b.y) < JAR_R) {
      b.banked += b.carried; b.carried = 0; b.mood = "hunt";
    }
    if (into >= LAND_AT && into < LAND_AT + 60 &&
        Math.hypot(data.swat.x - b.x, data.swat.y - b.y) < SWAT_R) {
      b.carried = 0;
    }
  }
}

/* ---------------- drawing ---------------- */

const grime = (() => {
  const r = mulberry32(7);
  return Array.from({ length: 90 }, () => ({ x: r() * W, y: r() * H, s: r() * 2.2 + 0.4 }));
})();

function draw(t, into, data) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#5b7b98"); g.addColorStop(0.55, "#38546f"); g.addColorStop(1, "#22374d");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.07; ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.moveTo(-200, H); ctx.lineTo(240, -80); ctx.lineTo(420, -80); ctx.lineTo(-20, H);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(360, H); ctx.lineTo(800, -80); ctx.lineTo(880, -80); ctx.lineTo(440, H);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  ctx.fillStyle = "rgba(255,255,255,.10)";
  for (const s of grime) { ctx.beginPath(); ctx.arc(s.x, s.y, s.s, 0, 6.283); ctx.fill(); }

  drawJar(data.jar, t);

  for (const c of data.crumbs) if (!taken.has(c.id)) drawCrumb(c.x, c.y, c.gold, c.spin + t / 3000);
  for (const [, c] of loose) drawCrumb(c.x, c.y, false, t / 2200, true);

  if (into >= SHADOW_AT) {
    const s = data.swat;
    if (into < LAND_AT) {
      const p = (into - SHADOW_AT) / (LAND_AT - SHADOW_AT);
      ctx.save();
      ctx.globalAlpha = 0.16 + p * 0.4; ctx.fillStyle = "#08111a";
      ctx.beginPath(); ctx.arc(s.x, s.y, SWAT_R * (1.9 - p * 0.9), 0, 6.283); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = `rgba(200,54,47,${0.35 + p * 0.5})`;
      ctx.lineWidth = 4; ctx.setLineDash([12, 10]); ctx.lineDashOffset = -t / 26;
      ctx.beginPath(); ctx.arc(s.x, s.y, SWAT_R, 0, 6.283); ctx.stroke();
      ctx.restore();
    } else if (into < CLEAR_AT) {
      drawSwatter(s.x, s.y);
    }
  }

  for (const b of bots) drawFly(b, b.name, b.banked, b.carried, false, 0, t);
  for (const f of flies.values()) drawFly(f, f.name, f.banked, f.carried, false, f.dash, t);
  if (joined) {
    const em = me.emote && t - me.emoteAt < 3200 ? me.emote : "";
    drawFly({ ...me, emote: em, emoteAt: me.emoteAt }, name, me.banked, me.carried, true,
            t < me.dashUntil ? 1 : 0, t, t < me.immuneUntil);
    if (t < me.splatUntil) {
      ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "#c8362f";
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

function drawJar(j, t) {
  ctx.save();
  ctx.translate(j.x, j.y);
  const pulse = 1 + Math.sin(t / 420) * 0.02 + bankGlow * 0.25;
  ctx.scale(pulse, pulse);

  ctx.globalAlpha = 0.22 + bankGlow * 0.4;
  ctx.fillStyle = "#e8a317";
  ctx.beginPath(); ctx.arc(0, 0, JAR_R, 0, 6.283); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#7a2f1d";
  roundRect(-30, -26, 60, 54, 8); ctx.fill();
  ctx.fillStyle = "#b2411f";
  roundRect(-26, -18, 52, 42, 6); ctx.fill();
  ctx.fillStyle = "#ede2c8";
  roundRect(-34, -36, 68, 14, 4); ctx.fill();
  ctx.fillStyle = "#2a1512";
  ctx.font = "700 11px Karla, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("JAM", 0, -26);

  ctx.strokeStyle = "rgba(232,163,23,.85)";
  ctx.lineWidth = 3; ctx.setLineDash([9, 9]); ctx.lineDashOffset = t / 40;
  ctx.beginPath(); ctx.arc(0, 0, JAR_R, 0, 6.283); ctx.stroke();
  ctx.restore();
}

function drawCrumb(x, y, gold, spin, isLoose) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(spin);
  if (gold) {
    ctx.shadowColor = "#ffd75e"; ctx.shadowBlur = 22;
    ctx.fillStyle = "#ffcf3d"; ctx.fillRect(-11, -11, 22, 22);
    ctx.shadowBlur = 0; ctx.fillStyle = "#fff1bd"; ctx.fillRect(-11, -11, 9, 9);
  } else {
    if (isLoose) { ctx.shadowColor = "rgba(255,255,255,.7)"; ctx.shadowBlur = 10; }
    ctx.fillStyle = "#e0c288"; ctx.fillRect(-8, -7, 16, 14);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#c8a663"; ctx.fillRect(-8, 2, 16, 5);
  }
  ctx.restore();
}

function drawSwatter(x, y) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(-0.35);
  ctx.fillStyle = "#c8362f";
  roundRect(-SWAT_R, -SWAT_R * 0.86, SWAT_R * 2, SWAT_R * 1.72, 26); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.28)"; ctx.lineWidth = 3;
  for (let i = -SWAT_R + 16; i < SWAT_R; i += 20) {
    ctx.beginPath(); ctx.moveTo(i, -SWAT_R * 0.86); ctx.lineTo(i, SWAT_R * 0.86); ctx.stroke();
  }
  for (let j = -SWAT_R * 0.86 + 14; j < SWAT_R * 0.86; j += 20) {
    ctx.beginPath(); ctx.moveTo(-SWAT_R, j); ctx.lineTo(SWAT_R, j); ctx.stroke();
  }
  ctx.fillStyle = "#8f2520"; ctx.fillRect(SWAT_R - 6, -14, 210, 28);
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

function drawFly(f, label, banked, carried, isMe, dashing, t, immune) {
  ctx.save();
  ctx.translate(f.x, f.y);

  if (dashing) {
    ctx.save();
    ctx.globalAlpha = 0.35; ctx.fillStyle = "#ede2c8";
    const d = Math.hypot(f.vx, f.vy) || 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(-(f.vx / d) * i * 11, -(f.vy / d) * i * 11, 10 - i * 2, 6 - i, 0, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  if (isMe) {
    ctx.strokeStyle = "rgba(232,163,23,.85)"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, 6.283); ctx.stroke();
  }
  if (immune) {
    ctx.strokeStyle = "rgba(237,226,200,.5)"; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(0, 0, 28, 0, 6.283); ctx.stroke();
    ctx.setLineDash([]);
  }

  // crumbs riding on its back
  if (carried > 0) {
    const n = Math.min(6, carried);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + t / 900;
      ctx.fillStyle = "#e0c288";
      ctx.fillRect(Math.cos(a) * 17 - 3, Math.sin(a) * 14 - 3, 6, 6);
    }
  }

  ctx.save();
  ctx.rotate(Math.atan2(f.vy, f.vx));
  const flap = 1 + Math.sin(t / 14 + f.x) * 0.5;
  ctx.globalAlpha = 0.45; ctx.fillStyle = "#e9dcc0";
  ctx.beginPath(); ctx.ellipse(-2, -6 * flap, 12, 4.5, -0.5, 0, 6.283); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-2, 6 * flap, 12, 4.5, 0.5, 0, 6.283); ctx.fill();
  ctx.globalAlpha = 1; ctx.fillStyle = "#17100e";
  ctx.beginPath(); ctx.ellipse(0, 0, 12, 7, 0, 0, 6.283); ctx.fill();
  ctx.fillStyle = isMe ? "#e8a317" : "#2e5fa3";
  ctx.beginPath(); ctx.ellipse(8, 0, 5.2, 4.8, 0, 0, 6.283); ctx.fill();
  ctx.restore();

  ctx.font = "700 13px Karla, sans-serif";
  ctx.textAlign = "center";
  const text = carried > 0 ? `${label} · ${banked} +${carried}` : `${label} · ${banked}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(10,18,26,.6)";
  roundRect(-w / 2 - 6, 18, w + 12, 19, 5); ctx.fill();
  ctx.fillStyle = isMe ? "#e8a317" : "#ede2c8";
  ctx.fillText(text, 0, 32);

  const emote = f.emote && t - (f.emoteAt || 0) < 3200 ? f.emote : "";
  if (emote) {
    ctx.font = "700 15px Karla, sans-serif";
    const ew = ctx.measureText(emote).width;
    ctx.fillStyle = "#ede2c8";
    roundRect(-ew / 2 - 10, -50, ew + 20, 26, 9); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-6, -25); ctx.lineTo(6, -25); ctx.lineTo(0, -16);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#2a1512"; ctx.fillText(emote, 0, -32);
  }
  ctx.restore();
}

/* ---------------- hud & boards ---------------- */

function updateHud() {
  hudScore.textContent = me.banked;
  hudWallet.textContent = me.wallet;
  hudCarry.textContent = me.carried;
  hudCarry.parentElement.classList.toggle("loaded", me.carried >= 6);
}

function maybeSave(t) {
  if (me.banked > bestSaved && t - lastSave > 60000) {
    bestSaved = me.banked; lastSave = t;
    saveScore(name, me.banked);
  }
}

function renderBoard() {
  const rows = [];
  if (joined) rows.push({ n: name, s: me.banked, c: me.carried, me: true });
  for (const f of flies.values()) rows.push({ n: f.name, s: f.banked, c: f.carried });
  for (const b of bots) rows.push({ n: b.name + " (bot)", s: b.banked, c: b.carried });
  rows.sort((a, b) => b.s - a.s);
  el("liveCount").textContent = String(rows.length);

  boardEl.innerHTML = rows.length
    ? rows.slice(0, 10).map((r, i) =>
        `<li class="${r.me ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who">${esc(r.n)}</span><span class="pts">${r.s}${r.c ? `<i>+${r.c}</i>` : ""}</span></li>`
      ).join("")
    : `<li class="empty">Nobody yet. Be the first fly.</li>`;
}
setInterval(renderBoard, 500);

watchScores((rows) => {
  hiEl.innerHTML = rows.length
    ? rows.map((r, i) =>
        `<li><span class="rank">${i + 1}</span><span class="who">${esc(r.n || "a fly")}</span><span class="pts">${r.s || 0}</span></li>`
      ).join("")
    : `<li class="empty">No records yet.</li>`;
});

addEventListener("pagehide", () => { if (me.banked > bestSaved) saveScore(name, me.banked); });

/* ---------------- boot ---------------- */

import("./db.js").then((m) => m.ready).then((r) => {
  if (r.demo) {
    spawnBots();
    net.onStatus("offline", "No Firebase config — playing locally with bots.");
    el("joinNote").textContent = "Demo mode: you'll be sharing the window with three bots.";
  } else {
    net.onStatus("waiting", "Ready. Land on the window to meet the others.");
  }
});

renderShop();
updateHud();
requestAnimationFrame(update);
