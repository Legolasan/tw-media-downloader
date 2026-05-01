# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install      # install deps
npm start        # run server on PORT (default 3000)
```

There is no test runner, linter, or build step. `npm start` runs `node server.js` directly.

## Architecture

Two files do all the work: `server.js` (Express backend) and `public/index.html` (single-page frontend with inline CSS + vanilla JS). Everything else is config.

### Job lifecycle (the core flow)

A "job" is the unit of work — it represents one user's download request and is held entirely in memory in the `jobs` object keyed by a random `jobId`. The frontend coordinates three endpoints in sequence:

1. **`POST /api/start`** — resolves the username to a userId via twitterapi.io, creates a tmpdir under `os.tmpdir()`, registers the job, kicks off `runJob()` as fire-and-forget, and returns `{ jobId }`.
2. **`GET /api/progress/:jobId`** — opens an SSE stream. Uses a buffered-replay pattern: each job stores all emitted events in `job.events` and active connections in `job.listeners`. New SSE clients first replay buffered events, then attach as a listener. This lets the frontend connect *after* the job has already started without missing events.
3. **`GET /api/zip/:jobId`** — streams the tmpdir as a ZIP via `archiver`, then deletes the tmpdir and removes the job from memory in the `res.on('finish')` handler. **The ZIP can only be downloaded once** — after that the job is gone.

### State is in-memory and single-server

The `jobs` map is process-local. There is no DB, no Redis, no persistence. A server restart drops all in-flight jobs and any completed-but-not-yet-downloaded ZIPs. This is intentional and matches Railway's ephemeral filesystem model — do not add persistence without a discussion of why.

### twitterapi.io rate limiting and pagination quirks

`runJob()` sleeps **5500ms between pagination requests** (`api.twitterapi.io/twitter/user/last_tweets`) because the free tier allows 1 request per 5 seconds. Do not remove this sleep.

The pagination loop has two safeguards that **must be preserved** if you touch it:
1. **Tweet-id dedup (`seenTweetIds`)** — `last_tweets` keeps returning `has_next_page: true` and re-serves the same tweets in a cursor loop after the user's timeline is exhausted. We dedup batches by `tweet.id` so the count stays honest. Without this, a user with ~100 tweets but `limit=350` will fetch the same 100 tweets ~25 times.
2. **`noNewStreak` tolerance** — break after **3 consecutive pages with no new tweets**. This covers two cases in one check: accounts that return empty first pages, and the cursor-loop case above.

### Media extraction and dedup

`extractMedia()` reads from **both** `tweet.extendedEntities.media` and `tweet.entities.media` (the latter is a fallback — some tweets only populate one) and dedups by `id_str` within a single tweet. Photos use `media_url_https` with `?name=large`. Videos and animated GIFs go through `bestVideo()`, which picks the highest-bitrate `video/mp4` variant. Filenames are `${tweet.id}_${m.id_str}${ext}` — this format is load-bearing for the cross-tweet dedup pass.

There are three dedup layers, and all three matter:
1. **In-tweet**: `seen` Set inside `extractMedia()` — same media can appear in both entity sources.
2. **Cross-tweet**: before downloading, `runJob()` parses the media id out of each filename via regex and skips repeats — the same media can appear in multiple tweets (quote tweets, reposts).
3. **Filesystem**: `fs.existsSync(dest)` during the download loop — last-line defense, also enables resumability within a job.

### API key handling

The user enters their twitterapi.io API key in the UI on every request; it's POSTed to `/api/start`, kept only in the in-memory job, and never written to disk or env. There are no required environment variables — do not introduce one for the API key.

## Deployment

`railway.json` declares a Nixpacks build with `npm start` as the start command. Node 18+ is required (`engines` field in `package.json`).
