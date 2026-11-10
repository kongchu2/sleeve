# Listening Log

A personal web app that stacks your Spotify listening history into a day-by-day calendar of album covers, and shows the current track with the album's point colour and synced lyrics.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard> (Web API) and register `http://127.0.0.1:8787/auth/callback` as the Redirect URI.
2. Copy `.env.example` to `.env` and fill in the Client ID and Secret.
3. `npm install`

## Run

- Development: `npm run dev` → <http://127.0.0.1:5180>
- Always-on: `npm run build && npm start` → <http://127.0.0.1:8787>

## How it works

- The server (`server/`) pulls Spotify's 50 most recent plays every 2 minutes into `data/listening.db` (SQLite). Spotify does not expose full history, so **only plays made while the server is running are kept**.
- The point colour is extracted in the browser from the album cover's pixels (`src/color.ts`).
- Lyrics come from [LRCLIB](https://lrclib.net), looked up by track and artist name and cached in the database.
- Playback control (play/pause, previous/next, click a lyric line to seek) requires Spotify Premium.
- Press `F` on the Now Playing screen for fullscreen.

## Deploy

Production runs as two processes sharing one SQLite database:

- `server/worker.ts` — collects plays every 2 minutes and publishes them to a separate **listening archive** git repository (`plays/YYYY-MM.jsonl`, one JSON object per play), pushing at most every 15 minutes. On start it also restores anything the archive has that the database lacks.
- `server/index.ts` with `COLLECT=0` — serves the built web app and the API.

Sketch (systemd units are in `deploy/`):

```sh
npm ci && npm run build
git clone <archive-repo> ../listening-archive     # the worker needs push access
# .env: Spotify credentials, DATA_REPO_DIR=../listening-archive
sudo cp deploy/*.service /etc/systemd/system/ && sudo systemctl enable --now listening-worker listening-web
```

The web server listens on `127.0.0.1:8787`; put it behind something that provides HTTPS and access control (it exposes playback control). Sign in to Spotify once locally and copy `data/listening.db` over, or register the deployed `/auth/callback` URL in the Spotify dashboard and set `SPOTIFY_REDIRECT_URI`.
