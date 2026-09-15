// Firebase bootstrap shared by the landing page and the game.
// If the config still has placeholders (or Firebase fails to reach the
// network), we fall back to DEMO mode and the site still works — it just
// stops being shared between visitors.

import { firebaseConfig, ROOM } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

export { ROOM };

export const configured = !JSON.stringify(firebaseConfig).includes("PASTE");

let _db = null;
let _uid = null;
let _mode = configured ? "pending" : "demo";

export function mode() { return _mode; }
export function uid() { return _uid; }

// Firestore functions get re-exported so callers only import from here.
export let fs = null;

export const ready = (async () => {
  if (!configured) {
    _uid = localId();
    return { db: null, uid: _uid, demo: true };
  }
  try {
    const [{ initializeApp }, firestore, { getAuth, signInAnonymously, onAuthStateChanged }] =
      await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-firestore.js`),
        import(`${SDK}/firebase-auth.js`)
      ]);

    const app = initializeApp(firebaseConfig);
    _db = firestore.getFirestore(app);
    fs = firestore;

    const auth = getAuth(app);
    await signInAnonymously(auth);
    _uid = await new Promise((resolve) => {
      onAuthStateChanged(auth, (u) => u && resolve(u.uid));
    });

    _mode = "live";
    return { db: _db, uid: _uid, demo: false };
  } catch (err) {
    console.warn("[OnlyFlys] Firebase unavailable, running in demo mode.", err);
    _mode = "demo";
    _uid = localId();
    return { db: null, uid: _uid, demo: true };
  }
})();

export function db() { return _db; }

function localId() {
  let id = localStorage.getItem("onlyflys:id");
  if (!id) {
    id = "local-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("onlyflys:id", id);
  }
  return id;
}

// ---- fly name generator (no free-text names, so nothing needs moderating)

const FIRST = ["Gnatalie", "Buzzlington", "Maggie", "Betty", "Horace", "Fiona", "Reginald",
  "Winona", "Mervyn", "Doris", "Clive", "Petunia", "Barnaby", "Sheila", "Otto", "Marge",
  "Vernon", "Agnes", "Duncan", "Beryl", "Trevor", "Enid"];

const LAST = ["Bincrawler", "Windowsmack", "Peachfingers", "Six-Legs", "of the Compost",
  "Lampshade", "Wingbeat", "Sugarfoot", "Jamside", "Drainpipe", "Buzzworth", "Crumbsworth",
  "Splatproof", "Yoghurtlid", "Fruitbowl", "Bannister"];

export function randomName() {
  const a = FIRST[(Math.random() * FIRST.length) | 0];
  const b = LAST[(Math.random() * LAST.length) | 0];
  return `${a} ${b}`;
}
