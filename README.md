# Luma

Luma is an installable web app (PWA) with accounts, **Luma Reels** (videos up to 15 minutes, plus pictures) and **Luma Music** (songs with album covers).

## Features

- **Installable PWA**: manifest, service worker (the app shell works offline), app icons and home-screen shortcuts built from the Luma star logo. It has iOS "Add to Home Screen" support and an Install button in Settings.
- **Accounts**: sign up, sign in and sign out, change password, display name, bio and profile photo. Sessions use HTTP-only cookies and passwords are hashed with scrypt.
- **Luma Reels**: a full-screen vertical feed with For You and Following tabs.
  - Video reels can be **up to 15 minutes** long. The length is checked in the browser before upload and again on the server (ffprobe if installed, otherwise the MP4/MOV header). Long videos get a seek bar.
  - Picture reels hold up to 10 photos in a swipeable carousel.
  - Likes, comments, sharing, and deleting your own posts.
- **Luma Music**: upload a song (MP3, M4A, WAV, FLAC, OGG) with an **album cover**, title, artist and album. A mini player stays open across pages, with a full-screen player, queue, play counts and lock-screen controls (Media Session).
- **Verified badge**: the glowing star shows next to verified names. The **first account created is the admin** (and verified). Admins can verify or unverify anyone from that person's profile.
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

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LUMA_DATA_DIR` | `./data` | SQLite database + uploaded media |
| `LUMA_MAX_VIDEO_MB` | `1024` | Max reel video size |
| `LUMA_MAX_IMAGE_MB` | `20` | Max picture / cover / avatar size |
| `LUMA_MAX_AUDIO_MB` | `150` | Max song size |
| `TRUST_PROXY` | unset | Set (e.g. `1`) when behind a TLS-terminating proxy so cookies are marked `Secure` |

Install `ffmpeg`/`ffprobe` on the server to get exact length checks for every video format. Without it, MP4/MOV lengths are still read from the file, and WebM falls back to the length the browser reports.

## Layout

```
server.js            Express API + static hosting
lib/db.js            SQLite schema
lib/media.js         Upload types, duration probing (15-minute limit)
lib/social.js        Social link validation
public/              The PWA (index.html, js/app.js, css/app.css, sw.js, manifest)
public/img/          Logo, verified badge, social badges
test/                API tests (node:test)
```
