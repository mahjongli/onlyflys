# OnlyFlys

A parody subscription platform for houseflies, plus **The Windowsill** — a
peer-to-peer multiplayer arena where you grab crumbs, carry them to a jam jar to
bank them, and dive-bomb anyone carrying more than you.

Static site. No build step. Hosted on GitHub Pages, with Firebase only doing
introductions.

```
index.html          landing page: creators, tiers, FAQ, the terrible advert
game.html           The Windowsill
404.html
css/style.css       shared tokens + landing page
css/game.css        arena
js/firebase-config.js   ← the only file you need to edit
js/db.js            Firebase bootstrap, anonymous auth, demo fallback, name generator
js/net.js           WebRTC mesh + Firestore signalling
js/game.js          simulation, rendering, interpolation
js/app.js           landing page
firestore.rules     paste into the Firebase console
```

## Why v1 burned through the free tier, and what changed

The first version sent every fly's position to Firestore three times a second
and read everyone else's back. That's a write per player per tick and a read per
player per player per tick — four people playing for ten minutes is tens of
thousands of operations. It also looked bad, because the only way to slow the
bleeding was to write less often, and writing less often means other flies jump
between positions instead of moving between them.

Firestore is a database. It was never going to be a good game transport.

**Now the browsers talk to each other directly.** Firestore is used once, to
introduce people: each pair exchanges a WebRTC offer and an answer (two
documents), and after that all gameplay traffic goes over a direct data channel
between the two machines at 15 Hz, costing nothing and arriving in milliseconds.

### The whole Firestore cost of a play session

| When | Operations |
|---|---|
| Joining the room | 1 write (presence) + 1 read per peer already there |
| Meeting each peer | ~2 writes (offer/answer) + 1 read + 1 delete |
| Every 5 minutes | 1 write, so a long session isn't swept up as a crash |
| Banking a new best | 1 write, at most once a minute |
| Leaving | 1 write (delete) |

A four-player hour is roughly **forty operations total**, against a free-tier
allowance of 20,000 writes and 50,000 reads a day. Position updates — thousands
per minute — never touch Firestore at all.

Two details keep it that low. ICE candidates are gathered fully before sending,
so each handshake is one document instead of one per candidate. And presence
heartbeats run every five minutes rather than every few seconds, because WebRTC
already tells each peer instantly when someone disconnects; the heartbeat only
exists so a crashed browser's document can be swept up later. Any client is
allowed to delete a presence doc that's been dead for fifteen minutes, so the
room tidies itself.

### And why other flies look smooth now

Remote flies are drawn **120 ms in the past**. Every incoming packet goes into a
short buffer, and each frame the renderer finds the two samples either side of
"now minus 120 ms" and moves between them, with a light low-pass filter on top to
absorb jitter in packet arrival. Because we're always rendering a moment we
already have data for, nothing is ever guessed and nothing snaps. If a packet is
genuinely late, it coasts on the last known velocity for up to 220 ms and picks
the interpolation back up when the next one lands.

Simulated against jittery 15 Hz packets, the renderer interpolates on 231 of 240
frames and never extrapolates.

### What about NAT?

Connections use Google's public STUN servers. That covers the large majority of
home networks. There is no TURN relay, because TURN means paying for bandwidth,
and the whole point here is free. On a restrictive network (some corporate and
mobile carriers) a pair may fail to connect; the status line says so and you keep
playing with whoever you could reach.

## Play

The loop is: **grab crumbs → carry them → bank them → spend or hoard.**

- Crumbs in your **gut** are speed penalty, theft bait and swatter fodder.
- Crumbs in the **jam jar** are banked: they become your score and your spending
  money. The jar moves every wave.
- **Dive** (space, the Dive button, or double-click) to ram another fly. A loaded
  fly drops most of its gut onto the glass for anyone to grab. There's a
  cooldown, and the victim gets a moment of immunity so nobody can be chain-hit.
- The **swatter** lands every 18 seconds after a telegraphed shadow. It empties
  your gut. It never touches your bank.
- **Spending** costs you spendable crumbs but never your banked score, so every
  upgrade is a real decision: faster wings and a sharper dive help you take other
  people's crumbs, but hoarding is what wins the board.

Carrying makes you slow, which means the leader is the easiest target — the game
balances itself.

## Run it now

Serve the folder (`python3 -m http.server`) and open `http://localhost:8000`. It
needs a server rather than `file://` because it uses ES modules.

With no Firebase config it runs in **demo mode**: everything works, and the arena
gives you three bots that hunt, bank and flee the swatter. To test real
multiplayer locally, open the page in two different browsers (or a normal window
and a private one) — they get different anonymous accounts and will connect to
each other over loopback.

## Deploy to GitHub Pages

1. Push to the root of a repo.
2. Settings → Pages → Source: *Deploy from a branch*, `main`, `/ (root)`.

All paths are relative, so it works in a subdirectory unchanged. **WebRTC needs a
secure context** — GitHub Pages is HTTPS, so this is already fine, but if you
host it elsewhere, plain HTTP will break peer connections.

## Wire up Firebase

1. Create a project at console.firebase.google.com.
2. **Build → Firestore Database → Create database.**
3. **Build → Authentication → Sign-in method → Anonymous → Enable.**
4. **Project settings → Your apps → Web (`</>`)** → copy the config into
   `js/firebase-config.js`.
5. **Firestore → Rules** → paste `firestore.rules` → Publish.
6. **Authentication → Settings → Authorized domains** → add `<you>.github.io`.

Those config values are not secrets — every Firebase web app ships them in plain
JavaScript. `firestore.rules` is what protects the data.

### Data layout

| Path | What's in it |
|---|---|
| `creators/{id}` | `clicks` — Subscribe presses, added to a hardcoded seed |
| `rooms/windowsill/peers/{uid}` | `n`, `t` — who's here, refreshed every 5 min |
| `rooms/windowsill/peers/{uid}/inbox/{fromUid}` | one WebRTC offer or answer, deleted as soon as it's read |
| `rooms/windowsill/hiscores/{uid}` | best banked score |

## Trust model

Gameplay is fully peer-trusting. A player's browser reports its own position,
score and "you just got hit by me", and everyone believes it. Someone with a
console open could give themselves a million crumbs. For a joke about flies that
is the right trade — authority would mean a server, and a server means money.
The Firestore rules do stop anyone writing to *other people's* documents, so the
worst case is a liar in one room, not a corrupted database.

## Tweaking

- **Feel** — `SEND_MS` (packet rate) and `INTERP_MS` (render delay) at the top of
  `js/game.js`. Raising `INTERP_MS` buys smoothness on bad connections at the
  cost of lag.
- **Balance** — `UPGRADES` costs, `maxSpeed()`, `dashCooldown()`, `RAM_R`,
  `JAR_R`, `SWAT_R`, `WAVE_MS`.
- **Room size** — `MAX_PEERS` in `js/net.js`. A full mesh means every player
  talks to every other, so 7 is a sensible ceiling.
- **Creators** — the `CREATORS` array in `js/app.js`.
- **Fly names** — `FIRST`/`LAST` in `js/db.js`. Players can't type their own
  names and emotes are fixed phrases, so there's nothing to moderate.
- **A second arena** — change `ROOM` in `js/firebase-config.js`.

## A note on the joke

The name is a pun, the creators are insects, and the content is bins and fruit.
Deliberately safe for work throughout. Not affiliated with, endorsed by, or
connected to any real subscription platform.
