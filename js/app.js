import { ready, db, fs, ROOM } from "./db.js";

/* ----------------------------------------------------------------
   1. Hero swarm — flies that scatter from your cursor
   ---------------------------------------------------------------- */

(function swarm() {
  const cv = document.getElementById("swarm");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let w = 0, h = 0, dpr = 1;
  const pointer = { x: -9999, y: -9999 };
  const flies = [];

  function resize() {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    flies.length = 0;
    const n = Math.max(9, Math.min(22, Math.round(w / 62)));
    for (let i = 0; i < n; i++) {
      flies.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - .5) * 1.4, vy: (Math.random() - .5) * 1.4,
        s: .7 + Math.random() * .7, phase: Math.random() * 6.28
      });
    }
  }

  function fly(f, t) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(Math.atan2(f.vy, f.vx));
    ctx.scale(f.s, f.s);

    // wing blur
    ctx.globalAlpha = .35;
    ctx.fillStyle = "#e9dcc0";
    const flap = 1 + Math.sin(t * 0.06 + f.phase) * 0.45;
    ctx.beginPath(); ctx.ellipse(-1, -4 * flap, 6, 2.6, -0.5, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-1, 4 * flap, 6, 2.6, 0.5, 0, 6.283); ctx.fill();

    // body
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#1c1210";
    ctx.beginPath(); ctx.ellipse(0, 0, 6, 3.4, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = "#2e5fa3";
    ctx.beginPath(); ctx.ellipse(4, 0, 2.6, 2.4, 0, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const f of flies) {
      // erratic drift
      f.vx += (Math.random() - .5) * .6;
      f.vy += (Math.random() - .5) * .6;

      // flee the cursor
      const dx = f.x - pointer.x, dy = f.y - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 22000) {
        const d = Math.sqrt(d2) || 1;
        f.vx += (dx / d) * 2.6;
        f.vy += (dy / d) * 2.6;
      }

      const sp = Math.hypot(f.vx, f.vy), max = 3.2;
      if (sp > max) { f.vx = f.vx / sp * max; f.vy = f.vy / sp * max; }

      f.x += f.vx; f.y += f.vy;
      if (f.x < -20) f.x = w + 20; if (f.x > w + 20) f.x = -20;
      if (f.y < -20) f.y = h + 20; if (f.y > h + 20) f.y = -20;

      fly(f, t);
    }
    requestAnimationFrame(frame);
  }

  addEventListener("resize", () => { resize(); seed(); });
  resize(); seed();

  if (calm) {
    ctx.clearRect(0, 0, w, h);
    flies.forEach((f) => fly(f, 0));
  } else {
    addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
    });
    addEventListener("pointerleave", () => { pointer.x = pointer.y = -9999; });
    requestAnimationFrame(frame);
  }
})();

/* ----------------------------------------------------------------
   2. Creators
   ---------------------------------------------------------------- */

const CREATORS = [
  { id: "gnatalie", name: "Gnatalie", handle: "@bin.adjacent", seed: 48213,
    beat: "Slow-living content from the space behind the fridge. Mostly a lifestyle account.",
    post: "Unboxing a peach I have been visiting for nine days (part 4)" },
  { id: "buzzington", name: "Sir Buzzington III", handle: "@thepane", seed: 12904,
    beat: "Hereditary windowpane commentator. Has never once been outside on purpose.",
    post: "I have identified the invisible wall. I will be attempting it again shortly." },
  { id: "maggie", name: "Maggie", handle: "@glowup", seed: 91755,
    beat: "Transformation account. Started as a lump in a bin bag. Look at her now.",
    post: "Before & after: 6 days, no filter, several regrettable meals" },
  { id: "betty", name: "Bluebottle Betty", handle: "@iridescent", seed: 63480,
    beat: "Beauty and shine. Explains how to catch the light while sitting on a bin lid.",
    post: "My 4-step routine (step 1 is vomiting on it, steps 2–4 are also that)" },
  { id: "wingbeat", name: "DJ Wingbeat", handle: "@220bpm", seed: 28610,
    beat: "Live sets performed entirely inside a lampshade at three in the morning.",
    post: "New single: 'Directly Into Your Ear (Extended Mix)'" },
  { id: "horace", name: "Horace", handle: "@horsefly", seed: 7442,
    beat: "Fitness and endurance. Long-haul flights, heavy landings, no apologies.",
    post: "Leg day. All six. Nobody understands how tired I am." },
  { id: "fiona", name: "Fiona", handle: "@fruitfly", seed: 155902,
    beat: "Wine reviews from inside the glass. She has fallen into every single one.",
    post: "A bold red with notes of oak, pear and me" },
  { id: "baron", name: "The Compost Baron", handle: "@estate", seed: 33127,
    beat: "Property content. Tours his holdings: the heap, the lower heap, the good heap.",
    post: "Estate tour: the east heap has turned, and it has turned beautifully" }
];

const grid = document.getElementById("creatorGrid");
const nf = new Intl.NumberFormat("en-GB");

function subbed(id) { return localStorage.getItem("onlyflys:sub:" + id) === "1"; }

if (grid) {
  grid.innerHTML = CREATORS.map((c) => `
    <article class="strip">
      <h3>${c.name}</h3>
      <div class="handle">${c.handle}</div>
      <p class="beat">${c.beat}</p>
      <p class="post">Latest: ${c.post}</p>
      <div class="meta">
        <span class="subs"><b data-count="${c.id}">${nf.format(c.seed)}</b> subs</span>
        <button class="sub-btn" data-sub="${c.id}" aria-pressed="${subbed(c.id)}">
          ${subbed(c.id) ? "Subscribed" : "Subscribe"}
        </button>
      </div>
    </article>`).join("");
}

const counts = new Map(CREATORS.map((c) => [c.id, 0]));

function paint() {
  for (const c of CREATORS) {
    const el = document.querySelector(`[data-count="${c.id}"]`);
    if (el) el.textContent = nf.format(c.seed + (counts.get(c.id) || 0));
  }
}

ready.then(({ demo }) => {
  if (demo) {
    // Demo mode: clicks still count, they just stay on this device.
    for (const c of CREATORS) {
      counts.set(c.id, +(localStorage.getItem("onlyflys:demo:" + c.id) || 0));
    }
    paint();
    return;
  }
  const { collection, onSnapshot } = fs;
  onSnapshot(collection(db(), "creators"), (snap) => {
    snap.forEach((d) => counts.set(d.id, d.data().clicks || 0));
    paint();
  });
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-sub]");
  if (!btn) return;
  const id = btn.dataset.sub;
  if (subbed(id)) {
    btn.animate(
      [{ transform: "rotate(0)" }, { transform: "rotate(-3deg)" }, { transform: "rotate(3deg)" }, { transform: "rotate(0)" }],
      { duration: 240 }
    );
    return;
  }

  localStorage.setItem("onlyflys:sub:" + id, "1");
  btn.setAttribute("aria-pressed", "true");
  btn.textContent = "Subscribed";
  counts.set(id, (counts.get(id) || 0) + 1);
  paint();

  const { demo } = await ready;
  if (demo) {
    localStorage.setItem("onlyflys:demo:" + id, String(counts.get(id)));
    return;
  }
  try {
    const { doc, setDoc, increment } = fs;
    await setDoc(doc(db(), "creators", id), { clicks: increment(1) }, { merge: true });
  } catch (err) {
    console.warn("[OnlyFlys] could not record subscription", err);
  }
});

/* ----------------------------------------------------------------
   3. Live fly count in the header
   ---------------------------------------------------------------- */

ready.then(({ demo }) => {
  const el = document.getElementById("liveCount");
  if (!el) return;
  if (demo) { el.textContent = "0"; return; }

  const { collection, onSnapshot } = fs;
  onSnapshot(collection(db(), "rooms", ROOM, "peers"), (snap) => {
    // Presence docs are refreshed every 5 minutes, so anything older
    // than about twice that is a browser that never said goodbye.
    const cutoff = Date.now() - 11 * 60000;
    let n = 0;
    snap.forEach((d) => { if ((d.data().t || 0) > cutoff) n++; });
    el.textContent = String(n);
  }, () => { el.textContent = "0"; });
});

/* ----------------------------------------------------------------
   4. The advert
   ---------------------------------------------------------------- */

(function advert() {
  const bar = document.getElementById("adbar");
  const modal = document.getElementById("adModal");
  if (!bar || !modal) return;

  const open = () => {
    modal.hidden = false;
    document.getElementById("modalClose").focus();
  };
  const close = () => { modal.hidden = true; };

  document.getElementById("adOpen").addEventListener("click", open);
  document.getElementById("modalClose").addEventListener("click", close);
  document.getElementById("modalNo").addEventListener("click", () => {
    close();
    bar.hidden = true;
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });

  // The close button dodges twice, then gives up. Clicking always works,
  // and it never dodges a keyboard user.
  const x = document.getElementById("adClose");
  let dodges = 0;
  x.addEventListener("mouseenter", () => {
    if (dodges >= 2) return;
    dodges++;
    x.style.transform = `translateY(-50%) translateX(${dodges === 1 ? -54 : -108}px)`;
  });
  x.addEventListener("click", () => { bar.hidden = true; });
})();
