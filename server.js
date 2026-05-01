const express  = require('express');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const archiver = require('archiver');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory job store — single-server, fine for Railway
const jobs = {};

// ── Helpers ───────────────────────────────────────────────────────────────

function apiGet(baseUrl, params, apiKey) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'X-API-Key': apiKey } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from API')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const tmp = destPath + '.part';
    const file = fs.createWriteStream(tmp);
    function fetch(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302)
          return fetch(res.headers.location);
        if (res.statusCode !== 200) {
          file.destroy();
          try { fs.unlinkSync(tmp); } catch {}
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); fs.renameSync(tmp, destPath); resolve(); });
        file.on('error', err => { try { fs.unlinkSync(tmp); } catch {} reject(err); });
      }).on('error', err => { try { fs.unlinkSync(tmp); } catch {} reject(err); });
    }
    fetch(fileUrl);
  });
}

function bestVideo(variants = []) {
  return variants
    .filter(v => v.content_type === 'video/mp4' && v.bitrate)
    .sort((a, b) => b.bitrate - a.bitrate)[0]?.url;
}

function extractMedia(tweet) {
  const items = [];
  for (const m of tweet.extendedEntities?.media || []) {
    if (m.type === 'photo') {
      const ext  = path.extname(m.media_url_https) || '.jpg';
      items.push({ url: m.media_url_https + '?name=large', name: `${tweet.id}_${m.id_str}${ext}`, kind: 'image' });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const vidUrl = bestVideo(m.video_info?.variants);
      if (vidUrl) {
        const ext = path.extname(vidUrl.split('?')[0]) || '.mp4';
        items.push({ url: vidUrl, name: `${tweet.id}_${m.id_str}${ext}`, kind: 'video' });
      }
    }
  }
  return items;
}

function emit(job, event, data) {
  job.events.push({ event, data });
  job.listeners.forEach(fn => fn(event, data));
}

// ── Core download runner ──────────────────────────────────────────────────

async function runJob(job) {
  const { apiKey, userId, username, limit, mediaType, tmpDir } = job;

  try {
    // 1. Fetch tweets
    emit(job, 'log', `Fetching tweets for @${username}…`);
    const tweets = [];
    let cursor = '', page = 0, emptyStreak = 0;

    while (tweets.length < limit) {
      page++;
      const res = await apiGet(
        'https://api.twitterapi.io/twitter/user/last_tweets',
        { userId, cursor },
        apiKey
      );
      if (res.error || res.status !== 'success') {
        throw new Error(res.message || res.msg || 'API error');
      }
      const batch = res.data?.tweets || [];
      tweets.push(...batch);
      emit(job, 'log', `Page ${page}: ${batch.length} tweets (${Math.min(tweets.length, limit)} / ${limit})`);

      if (!res.has_next_page) break;
      // Some accounts return empty first pages — keep paginating up to 3 empty pages
      if (batch.length === 0) { emptyStreak++; if (emptyStreak >= 3) break; }
      else emptyStreak = 0;

      cursor = res.next_cursor;
      await new Promise(r => setTimeout(r, 5500));
    }

    const capped = tweets.slice(0, limit);

    // 2. Collect media
    let allMedia = [];
    for (const t of capped) allMedia.push(...extractMedia(t));

    const filtered = mediaType === 'all'
      ? allMedia
      : allMedia.filter(m => m.kind === mediaType);

    const imgCount = allMedia.filter(m => m.kind === 'image').length;
    const vidCount = allMedia.filter(m => m.kind === 'video').length;

    emit(job, 'log', `Found ${allMedia.length} media items — ${imgCount} images, ${vidCount} videos`);
    if (mediaType !== 'all')
      emit(job, 'log', `Filtering to ${mediaType}s: ${filtered.length} items`);

    if (filtered.length === 0) {
      emit(job, 'done', { downloaded: 0, failed: 0, skipped: 0, total: 0 });
      job.status = 'done';
      return;
    }

    emit(job, 'total', filtered.length);

    // 3. Deduplicate media by id_str before downloading (same media can appear in multiple tweets)
    const seen = new Set();
    const uniqueFiltered = filtered.filter(m => {
      // Extract media id_str from filename (format: tweetId_mediaId.ext)
      const match = m.name.match(/_\d+/);
      if (!match) return true;
      const mediaId = match[0].slice(1); // remove leading underscore
      if (seen.has(mediaId)) return false;
      seen.add(mediaId);
      return true;
    });

    if (uniqueFiltered.length < filtered.length) {
      emit(job, 'log', `Deduplicated: ${filtered.length} → ${uniqueFiltered.length} unique media items`);
    }

    // 4. Download each file
    let downloaded = 0, failed = 0, skipped = 0;

    for (const [i, item] of uniqueFiltered.entries()) {
      const dest = path.join(tmpDir, item.name);
      if (fs.existsSync(dest)) {
        skipped++;
        emit(job, 'progress', { i: i + 1, total: uniqueFiltered.length, file: item.name, status: 'skip', downloaded, failed, skipped });
        continue;
      }
      try {
        await downloadFile(item.url, dest);
        downloaded++;
        const size = Math.round(fs.statSync(dest).size / 1024);
        emit(job, 'progress', { i: i + 1, total: uniqueFiltered.length, file: item.name, status: 'ok', size, downloaded, failed, skipped });
      } catch (err) {
        failed++;
        emit(job, 'progress', { i: i + 1, total: uniqueFiltered.length, file: item.name, status: 'fail', err: err.message, downloaded, failed, skipped });
      }
    }

    job.status = 'done';
    emit(job, 'done', { downloaded, failed, skipped, total: uniqueFiltered.length });

  } catch (err) {
    job.status = 'error';
    emit(job, 'error', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// Start a download job
app.post('/api/start', async (req, res) => {
  const { apiKey, username, limit, mediaType } = req.body;

  if (!apiKey || !username || !limit)
    return res.status(400).json({ error: 'Missing required fields' });

  // Resolve username → userId
  let userId;
  try {
    const info = await apiGet(
      'https://api.twitterapi.io/twitter/user/info',
      { userName: username.replace('@', '') },
      apiKey
    );
    if (info.error || !info.data?.id)
      return res.status(400).json({ error: info.message || 'User not found' });
    userId = info.data.id;
  } catch (e) {
    return res.status(400).json({ error: 'Could not reach twitterapi.io: ' + e.message });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), `tw-job-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  jobs[jobId] = {
    jobId,
    status: 'running',
    apiKey,
    userId,
    username: username.replace('@', ''),
    limit: Math.min(parseInt(limit, 10) || 50, 1000),
    mediaType: mediaType || 'all',
    tmpDir,
    events:    [],   // buffered for late SSE connections
    listeners: [],   // active SSE connections
  };

  runJob(jobs[jobId]); // fire and forget

  res.json({ jobId });
});

// SSE progress stream
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).send('Job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay buffered events for late connections
  for (const { event, data } of job.events) send(event, data);

  if (job.status === 'done' || job.status === 'error') return res.end();

  const listener = (event, data) => {
    send(event, data);
    if (event === 'done' || event === 'error') {
      res.end();
      job.listeners = job.listeners.filter(l => l !== listener);
    }
  };
  job.listeners.push(listener);
  req.on('close', () => {
    job.listeners = job.listeners.filter(l => l !== listener);
  });
});

// Serve ZIP
app.get('/api/zip/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done')
    return res.status(404).send('Job not ready or not found');

  const filename = `${job.username}_media.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); });
  archive.pipe(res);
  archive.directory(job.tmpDir, false);
  archive.finalize();

  res.on('finish', () => {
    try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch {}
    delete jobs[job.jobId];
  });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
