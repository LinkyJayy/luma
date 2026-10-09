# Luma

Luma is an installable web app (PWA) with accounts, **Luma Reels** (videos up to 15 minutes, plus pictures) and **Luma Music** (songs with album covers).

## Features

- **Home**: the start screen, with everything in one place. It has search, a tile for every section (Reels, Music, Playables, Create, Search, Profile, Settings, and Admin for admins), plus rails of the latest reels, new songs and the five games.
- **Installable PWA**: manifest, service worker (the app shell works offline), app icons and home-screen shortcuts built from the Luma star logo. It has iOS "Add to Home Screen" support and an Install button in Settings.
- **Accounts**: sign up, sign in and sign out, change password, display name, bio and profile photo. Sessions use HTTP-only cookies and passwords are hashed with scrypt.
- **Luma Reels**: a full-screen vertical feed with For You and Following tabs.
  - Video reels can be **up to 15 minutes** long. The length is checked in the browser before upload and again on the server (ffprobe if installed, otherwise the MP4/MOV header). Long videos get a seek bar.
  - Picture reels hold up to 10 photos in a swipeable carousel.
  - Likes, comments, sharing, and deleting your own posts.
- **Luma Music**: upload a song (MP3, M4A, WAV, FLAC, OGG) with an **album cover**, title, artist and album. A mini player stays open across pages, with a full-screen player, queue, play counts and lock-screen controls (Media Session).
- **Verified badge**: the glowing star shows next to verified names.
- **Admin tools** (`#/admin`, or the shield icon on your profile):
  - The **first account created is the owner**. It is an admin, verified, and can't be demoted or suspended.
  - **Owner**: can give and remove the verified badge, **make people admins** (or remove admin), and suspend or clean up anyone, including other admins.
  - **Admins**: can give and remove verified badges and moderate regular users. They can't hand out admin, act on other admins, or touch the owner.
  - **Reports**: anyone signed in can report a reel, song, comment or account. Admins review a queue with a preview of what was reported, then remove it (or suspend the account) or dismiss the report. One decision closes every open report on the same thing.
  - **Suspend**: the person is signed out everywhere, can't sign in (they see the reason), and their profile, reels, songs and comments disappear for everyone except admins. Unsuspending brings everything back.
  - **Remove all content**: deletes every reel, picture, song and comment from an account.
  - **Overview** stats and an **audit log** of every admin action.
  - Comments can be deleted by their author, the reel's author or an admin. Songs can be deleted by the uploader or an admin.
- **Luma Playables** (`#/play`, the **Play** tab): five games. Multiplayer uses rooms with a 4-letter code or invite link; you need to be signed in to host or join. Every multiplayer game offers 13 team colours: red, orange, yellow, green, teal, blue, purple, pink, hot pink, white, light gray, dark gray and brown. Characters and circles are recoloured to match each team.
  - **LumaKart** (2–8 players): a night-time race where each player is a star kart in their chosen colour, racing 1, 3 or 5 laps. The camera follows from behind your kart, so ◀/▶ always steer the way they point. Item boxes give power-ups: **Double speed** (1.5× speed), **Triple speed** (2× speed) and **Thunder** (2× speed, and freezes everyone else for 5 seconds).
  - **Circle Chaos** (2–8 players): 15 rounds, so 15 turns each. On your turn your character lights up in your team colour. Tap a circle in your colour (+1) or a rainbow circle: **−2** or **−4** takes that many from any player you choose and gives them to you. Most circles wins.
  - **StarEscape** (solo or multiplayer): a Subway Surfers-style runner. Switch lanes, jump and slide past barriers and trains, and collect bolts while a black-star cop chases you. In multiplayer the host decides who runs and who plays a cop: one cop against everyone, or any mix.
  - **StarInvaders** (solo or multiplayer): Space Invaders, where your star fires bolts at circles worth 10–50 points each. Rounds last 2 minutes and the highest score wins.
  - **StarWordle**: Wordle, with a daily word that's the same for everyone, unlimited practice words, stats and a shareable result grid.
- **Social badges**: TikTok, YouTube, Instagram, Facebook, X and Linktree. You can enter a username or a link in Settings, and the links only work for each platform's real domain.
- Follows, search (people and songs), and profile grids for reels and music.

## Run it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Service workers (and installing the app) need **HTTPS** in production; `localhost` works for development.

## Deploy on Railway

Luma ships with a `Dockerfile` and a `railway.json`, so Railway builds and runs it with no extra setup.

1. In Railway, create a **New Project → Deploy from GitHub repo** and pick this repository (and the branch you want to deploy).
2. **Attach a volume** to the service (right-click the service → *Attach volume*, or `railway volume add`). Any mount path works, e.g. `/data`. Luma stores its database and every upload there automatically via `RAILWAY_VOLUME_MOUNT_PATH`.
   **Without a volume, all accounts and uploads are wiped on every redeploy.** The logs print a warning if one is missing.
3. Under **Settings → Networking**, click **Generate Domain** and set the port to **8080**. Railway serves it over HTTPS, which the PWA needs to be installable.

### "Application failed to respond"

This almost always means the domain points at a different port than Luma is listening on.

1. Open the latest deploy's **Deploy Logs** and find `Luma is running on port …`.
2. Go to **Settings → Networking**, then edit the domain (pencil icon). Set its port to that same number, usually **8080**.
3. If that log line is missing, Luma crashed while starting. The error just above it in the logs says why.
4. Open the URL and **sign up right away**. The first account becomes the owner and admin.

What the Railway setup does:

- **Build**: the `Dockerfile` uses Node 22 plus `ffmpeg`, so ffprobe checks the 15-minute reel limit exactly for every video format.
- **Port**: listens on Railway's `PORT`.
- **Healthcheck**: `/api/health`. Railway only switches traffic to a new deploy once it responds.
- **Restarts**: on failure, up to 5 times.
- **HTTPS**: Railway's proxy is trusted automatically, so session cookies are marked `Secure`.
- **Shutdown**: on redeploy, in-flight requests finish and the database is closed cleanly.

Notes:

- A Railway volume is tied to one service with one replica. Keep the service at **1 replica**, because SQLite and local uploads aren't shared between instances.
- Large reels (up to `LUMA_MAX_VIDEO_MB`, default 1 GB) count against the volume's size. Grow the volume, or lower the limit, to fit your plan.
- You can set any variable from the table below in the service's **Variables** tab.
- Luma Playables multiplayer uses WebSockets on the same port, which Railway supports with no extra setup. Each game runs in the host's browser, so the host should keep the game open in the foreground.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` in Docker/Railway, else `3000` | HTTP port |
| `LUMA_DATA_DIR` | Railway volume, else `./data` | SQLite database + uploaded media |
| `LUMA_MAX_VIDEO_MB` | `1024` | Max reel video size |
| `LUMA_MAX_IMAGE_MB` | `20` | Max picture / cover / avatar size |
| `LUMA_MAX_AUDIO_MB` | `150` | Max song size |
| `TRUST_PROXY` | `1` on Railway, else unset | Set (e.g. `1`) when behind a TLS-terminating proxy so cookies are marked `Secure` |

Install `ffmpeg`/`ffprobe` on the server to get exact length checks for every video format. Without it, MP4/MOV lengths are still read from the file, and WebM falls back to the length the browser reports.

## Layout

```
server.js            Express API + static hosting
lib/db.js            SQLite schema
lib/media.js         Upload types, duration probing (15-minute limit)
lib/social.js        Social link validation
lib/rooms.js         Multiplayer rooms over WebSockets (/ws/play)
public/              The PWA (index.html, js/app.js, css/app.css, sw.js, manifest)
public/js/play/      Luma Playables: hub/lobby, one module per game, shared helpers
public/img/          Logo, verified badge, social badges, game sprites (img/play)
test/                API, admin, rooms and LumaKart race tests (node:test)
Dockerfile           Container image (Node 22 + ffmpeg)
railway.json         Railway build/deploy settings
```
