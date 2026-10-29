// Gotcha — zero-dependency POC server. Wraps yt-dlp: analyse a URL, queue downloads, report progress.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3006;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
const MAX_PARALLEL = 2;

// ---------- yt-dlp helpers ----------

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`))));
  });
}

const thumbOf = e => e.thumbnail || e.thumbnails?.at(-1)?.url || null;
const heightsOf = e => [...new Set((e.formats || []).map(f => f.height).filter(Boolean))].sort((a, b) => b - a);

function toItem(e, fallbackUrl) {
  return {
    id: e.id,
    url: e.webpage_url || e.url || fallbackUrl,
    title: e.title || e.id || 'untitled',
    thumbnail: thumbOf(e),
    duration: e.duration || null,
    uploader: e.uploader || e.channel || null,
    heights: heightsOf(e),
  };
}

// Fallback for pages yt-dlp has no extractor for: scrape direct media links from the HTML.
async function scrapeMedia(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const found = new Set();
  const re = /(?:src|href|content|data-src)\s*=\s*["']([^"']+\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:\?[^"']*)?)["']/gi;
  for (const m of html.matchAll(re)) {
    try { found.add(new URL(m[1].replace(/&amp;/g, '&'), url).href); } catch {}
  }
  return [...found].map((u, i) => ({
    id: `direct-${i}`, url: u, title: decodeURIComponent(new URL(u).pathname.split('/').pop()),
    thumbnail: null, duration: null, uploader: 'direct link', heights: [],
  }));
}

// Rewrite URL shapes yt-dlp has no extractor for into ones it does.
// Rules live in rewrites.local.json (gitignored): [{ "match": "<regex>", "replace": "<replacement with $1…>" }]
const URL_REWRITES = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'rewrites.local.json'), 'utf8'))
      .map(r => [new RegExp(r.match, 'i'), r.replace]);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`rewrites.local.json ignored: ${e.message}`);
    return [];
  }
})();

function normaliseUrl(url) {
  for (const [re, replacement] of URL_REWRITES) if (re.test(url)) return url.replace(re, replacement);
  return url;
}

async function analyse(rawUrl) {
  const url = normaliseUrl(rawUrl);
  try {
    const info = JSON.parse(await runYtdlp(['-J', '--flat-playlist', '--no-warnings', url]));
    if (info._type === 'playlist') {
      return { source: 'yt-dlp', title: info.title, items: (info.entries || []).map(e => toItem(e)) };
    }
    return { source: 'yt-dlp', title: info.title, items: [toItem(info, url)] };
  } catch (err) {
    const items = await scrapeMedia(url).catch(() => []);
    if (items.length) return { source: 'scrape', title: url, items };
    throw err;
  }
}

// ---------- download queue ----------

const jobs = [];
let nextJobId = 1;

function formatArgs(quality) {
  if (quality === 'mp3') return ['-x', '--audio-format', 'mp3'];
  if (quality === 'best') return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'];
  const h = Number(quality);
  return ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]`, '--merge-output-format', 'mp4'];
}

function pump() {
  while (jobs.filter(j => j.status === 'running').length < MAX_PARALLEL) {
    const job = jobs.find(j => j.status === 'queued');
    if (!job) return;
    start(job);
  }
}

function start(job) {
  job.status = 'running';
  const args = [
    ...formatArgs(job.quality),
    '--no-playlist', '--newline', '--no-warnings',
    '--progress-template', 'download:PROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-P', DOWNLOAD_DIR,
    '-o', '%(title).150B [%(id)s].%(ext)s',
    job.url,
  ];
  const p = spawn('yt-dlp', args, { windowsHide: true });
  job.proc = p;
  let lastErr = '';
  const onLine = line => {
    const m = line.match(/^PROG\s+([\d.]+)%\|([^|]*)\|(.*)$/);
    if (m) {
      job.percent = parseFloat(m[1]);
      job.speed = m[2].trim();
      job.eta = m[3].trim();
    } else if (/Merging formats|ExtractAudio/.test(line)) {
      job.phase = 'post-processing';
    }
  };
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  });
  p.stderr.on('data', d => (lastErr = String(d).trim().split('\n').pop()));
  p.on('error', e => { job.status = 'error'; job.error = e.message; pump(); });
  p.on('close', code => {
    job.proc = null;
    if (job.status === 'cancelled') return pump();
    job.status = code === 0 ? 'done' : 'error';
    if (code === 0) job.percent = 100;
    else job.error = lastErr || `yt-dlp exited ${code}`;
    pump();
  });
}

const publicJob = ({ proc, ...j }) => j;

// ---------- HTTP ----------

const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', d => (b += d));
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});

const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(path.join(ROOT, 'public', 'index.html')));
    }
    if (req.method === 'POST' && req.url === '/api/analyse') {
      const { url } = await readBody(req);
      if (!/^https?:\/\//i.test(url || '')) return send(res, 400, { error: 'Please paste an http(s) URL.' });
      return send(res, 200, await analyse(url));
    }
    if (req.method === 'POST' && req.url === '/api/download') {
      const { items = [], quality = 'best' } = await readBody(req);
      for (const it of items) {
        jobs.push({ id: nextJobId++, url: it.url, title: it.title, quality, status: 'queued', percent: 0, speed: '', eta: '', phase: '' });
      }
      pump();
      return send(res, 200, { queued: items.length });
    }
    if (req.method === 'GET' && req.url === '/api/jobs') {
      return send(res, 200, jobs.map(publicJob));
    }
    const cancel = req.url.match(/^\/api\/jobs\/(\d+)\/cancel$/);
    if (req.method === 'POST' && cancel) {
      const job = jobs.find(j => j.id === Number(cancel[1]));
      if (job && (job.status === 'queued' || job.status === 'running')) {
        job.status = 'cancelled';
        job.proc?.kill();
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/clear') {
      for (let i = jobs.length - 1; i >= 0; i--) if (!['queued', 'running'].includes(jobs[i].status)) jobs.splice(i, 1);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/open-folder') {
      spawn('explorer', [DOWNLOAD_DIR], { detached: true });
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Gotcha → http://localhost:${PORT}  (downloads: ${DOWNLOAD_DIR})`));
