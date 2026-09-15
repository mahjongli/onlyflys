# OnlyFlys

A parody subscription platform for houseflies, plus **The Windowsill** — a real-time
multiplayer arena where everyone with the page open is a fly on the same kitchen window,
racing for crumbs before a swatter comes down.

Static site. No build step. Hosted on GitHub Pages, shared state in Cloud Firestore.

```
index.html          landing page: creators, tiers, FAQ, the terrible advert
game.html           The Windowsill
404.html
css/style.css       shared tokens + landing page
css/game.css        arena
js/firebase-config.js   ← the only file you need to edit
js/db.js            Firebase bootstrap, anonymous auth, demo fallback, name generator
js/app.js           hero swarm, subscriber counters, advert
js/game.js          the game
firestore.rules     paste into the Firebase console
```

## Run it right now

Open `index.html` through any local server (`python3 -m http.server`, then visit
`http://localhost:8000`). It needs a server, not `file://`, because it uses ES modules.

With no Firebase config it runs in **demo mode**: everything works, subscriber counts
save to your own browser, and the arena gives you three bot flies for company.

## Put it on GitHub Pages

1. Push these files to the root of a repo.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Wait a minute. It's live at `https://<you>.github.io/<repo>/`.

Everything is relative paths, so it works in a subdirectory without changes.

## Wire up Firestore

1. Create a project at console.firebase.google.com.
2. **Build → Firestore Database → Create database.** Production mode is fine; the rules
   below replace whatever it starts with.
3. **Build → Authentication → Sign-in method → Anonymous → Enable.** The game signs
   everyone in silently; without this, nothing writes.
4. **Project settings → Your apps → Web (`</>`)** → register the app → copy the config
   object into `js/firebase-config.js`.
5. **Firestore → Rules** → paste the contents of `firestore.rules` → Publish.
6. **Authentication → Settings → Authorized domains** → add `<you>.github.io`.

Those config values are not secrets — every Firebase web app ships them in plain
JavaScript. The rules file is what protects the data.

### Data layout

| Path | What's in it |
|---|---|
| `creators/{id}` | `clicks` — how many people hit Subscribe, added to a hardcoded seed number |
| `rooms/windowsill/players/{uid}` | live fly: name, x, y, score, wave, crumbs eaten, emote |
| `rooms/windowsill/hiscores/{uid}` | best score for that anonymous user |

## How the multiplayer works

Crumbs and the swatter are **deterministic**, not synced. Every client derives them from
the current 14-second wave number using a seeded PRNG, so all browsers independently
generate identical crumb layouts and an identical swatter position. Nobody has to be the
authority, and no writes are spent spawning anything.

Firestore only carries what it genuinely has to: each fly writes its own document about
three times a second, containing position, score, the crumb indices it ate this wave, and
its current emote. Everyone reads everyone else's document and unions the eaten lists, so
a crumb disappears for all players. It's fully client-trusting — fine for a joke, not fine
for anything with stakes.

Wave timing uses each device's own clock. If someone's clock is badly wrong their swatter
will land at the wrong moment. The 1.6-second shadow warning absorbs normal drift.

### Free tier

Spark gives you 20,000 Firestore writes a day. At ~3 writes/second, one player in the
arena burns through that in roughly two hours of continuous play. Knobs:

- `WRITE_MS` in `js/game.js` — raise to 500 or 700; remote flies are interpolated, so it
  still looks smooth.
- `WAVE_MS` — longer waves, fewer eat-triggered writes.
- Idle flies already skip writes entirely until the 5-second presence refresh.

If it ever gets popular, set a budget alert before it gets expensive.

## Tweaking

- **Creators** — the `CREATORS` array at the top of `js/app.js`. The `seed` is the fake
  starting subscriber count; real clicks are added on top.
- **Fly names** — `FIRST` and `LAST` in `js/db.js`. Players can't type their own names,
  so there's nothing to moderate.
- **Emotes** — the `data-emote` buttons in `game.html`. Fixed phrases only, same reason.
- **Difficulty** — `SWAT_R`, `CRUMBS`, `SHADOW_AT` and `LAND_AT` in `js/game.js`.
- **A second, separate arena** — change `ROOM` in `js/firebase-config.js`.

## A note on the joke

The name is a pun, the creators are insects, and the content is bins and fruit. It's
deliberately safe for work throughout. Not affiliated with, endorsed by, or connected to
any real subscription platform.
