# Twitter Media Downloader

A dark-themed web UI to download images and videos from any public X (Twitter) account as a ZIP file. Powered by [twitterapi.io](https://twitterapi.io).

![Dark UI with form, progress bar, and live download log](https://img.shields.io/badge/UI-Dark%20Theme-7c5cfc?style=flat-square) ![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js) ![Railway Ready](https://img.shields.io/badge/Railway-Deploy%20Ready-0B0D0E?style=flat-square&logo=railway)

## Features

- Paste any public X username and download all their media in one click
- Filter by **images only**, **videos only**, or **both**
- Set a post limit (1–1000)
- Live progress bar and per-file log streamed in real time
- All files bundled into a single ZIP and downloaded to your browser
- No login or Twitter developer account required — just a twitterapi.io API key

## Getting Started

### 1. Get an API Key

Sign up for free at [twitterapi.io](https://twitterapi.io). You get trial credits instantly with no credit card required. Pricing is $0.15 per 1,000 tweets fetched.

### 2. Run Locally

```bash
git clone https://github.com/Legolasan/tw-media-downloader
cd tw-media-downloader
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Use the UI

| Field | Description |
|---|---|
| API Key | Your twitterapi.io key |
| Twitter Username | e.g. `iam___smash` or `@iam___smash` |
| Post Limit | How many recent posts to scan (max 1000) |
| Media Type | Images only / Videos only / Both |

Click **Download Media** → watch the live progress → click **Download ZIP** when done.

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Push this repo to GitHub (already done if you're reading this)
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select this repository
4. Railway auto-detects Node.js via `package.json` and deploys in ~1 minute
5. A public URL is assigned automatically (e.g. `https://tw-media-downloader.up.railway.app`)

No environment variables are required. The API key is entered by the user in the UI each time.

## How It Works

```
Browser → POST /api/start       → resolves username to userId, starts download job
Browser → GET  /api/progress/:id → Server-Sent Events stream (live progress)
Browser → GET  /api/zip/:id      → streams ZIP of all downloaded files
```

- Downloads are stored temporarily in `/tmp` on the server
- ZIP is streamed directly to the browser and cleaned up immediately after
- Free tier of twitterapi.io allows 1 request every 5 seconds; the server handles this automatically

## Caveats

- **Post limit vs media count**: one post can contain up to 4 images, so fetching 50 posts may yield 100+ files
- **Railway ephemeral storage**: files live in `/tmp` and are deleted after the ZIP is served — this is intentional
- **Rate limit**: on the free twitterapi.io tier, fetching 100 posts takes ~30 seconds due to the 5s/request limit. Upgrade to a paid tier for faster fetches
- **Videos**: highest available bitrate MP4 is always selected

## Stack

- **Backend**: Node.js, Express, Server-Sent Events
- **Compression**: archiver (ZIP)
- **Data**: twitterapi.io REST API
- **Frontend**: Vanilla JS, no frameworks
