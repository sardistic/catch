const http = require('node:http');
const { spawn } = require('node:child_process');
const { createReadStream, promises: fs } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 12 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 3;
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

const SUPPORTED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com'
];

const PLATFORM_NAMES = {
  youtube: 'YouTube',
  youtu: 'YouTube',
  twitter: 'X / Twitter',
  x: 'X / Twitter',
  instagram: 'Instagram',
  tiktok: 'TikTok'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

let activeJobs = 0;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    // analytics.sardistic.com is our own Umami instance: it serves the tracker
    // (script-src) and receives the beacon (connect-src). Everything else stays
    // locked to 'self' — this widens the policy by exactly one origin we run.
    "default-src 'self'; img-src 'self' https: data:; style-src 'self';" +
      " script-src 'self' https://analytics.sardistic.com;" +
      " connect-src 'self' https://analytics.sardistic.com; frame-ancestors 'none'"
  );
}

function normalizeMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Paste a valid media URL.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('That doesn’t look like a valid URL.');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS links are supported.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const supported = SUPPORTED_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`)
  );

  if (!supported) {
    throw new Error('Use a YouTube, X, Instagram, or TikTok link.');
  }

  parsed.hash = '';
  return parsed.toString();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid request body.'));
      }
    });
    req.on('error', reject);
  });
}

function runYtDlp(args, { timeout = 45_000, maxOutput = MAX_METADATA_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('The media host took too long to respond.'));
    }, timeout);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        child.kill();
        finish(new Error('The media response was unexpectedly large.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', () => finish(new Error('yt-dlp is not installed or could not be started.')));
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        finish(null, Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8');
      finish(new Error(cleanYtDlpError(detail)));
    });
  });
}

function cleanYtDlpError(raw) {
  const text = raw
    .split(/\r?\n/)
    .filter((line) => /error:/i.test(line))
    .pop()
    ?.replace(/^.*?error:\s*/i, '')
    .trim();

  if (!text) return 'Could not read that link. It may be private, expired, or unsupported.';
  if (/login|cookies|private|age.?restricted/i.test(text)) {
    return 'This media requires an account or is not public.';
  }
  return text.slice(0, 280);
}

function getPlatform(info, mediaUrl) {
  const raw = `${info.extractor_key || ''} ${info.extractor || ''}`.toLowerCase();
  const host = new URL(mediaUrl).hostname.toLowerCase();
  const key = Object.keys(PLATFORM_NAMES).find((name) => raw.includes(name) || host.includes(name));
  return PLATFORM_NAMES[key] || 'Video';
}

function availableQualities(formats = []) {
  const heights = formats
    .filter((format) => format.vcodec && format.vcodec !== 'none' && Number(format.height))
    .map((format) => Number(format.height));
  const maximum = Math.max(...heights, 0);
  const options = [360, 720, 1080, 1440, 2160]
    .filter((height) => maximum >= height)
    .map((height) => ({ value: String(height), label: height >= 2160 ? '4K' : `${height}p` }));

  if (!options.length && maximum) {
    options.push({ value: String(maximum), label: `${maximum}p` });
  }
  options.push({ value: 'best', label: 'Best' });
  return options;
}

async function inspectMedia(req, res) {
  const body = await readJsonBody(req);
  const mediaUrl = normalizeMediaUrl(body.url);
  const output = await runYtDlp([
    '--dump-single-json',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--socket-timeout',
    '15',
    mediaUrl
  ]);
  const info = JSON.parse(output);

  if (info._type === 'playlist') {
    throw new Error('Playlists are not supported. Paste a link to one video.');
  }

  sendJson(res, 200, {
    title: String(info.title || 'Untitled video').slice(0, 300),
    creator: String(info.uploader || info.channel || info.creator || 'Unknown creator').slice(0, 160),
    duration: Number(info.duration) || null,
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : null,
    platform: getPlatform(info, mediaUrl),
    qualities: availableQualities(info.formats),
    mediaUrl
  });
}

function sanitizeFilename(value) {
  const safe = String(value || 'download')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return safe || 'download';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function formatSelector(kind, quality) {
  if (kind === 'audio') return 'bestaudio/best';
  if (quality === 'best') return 'bv*+ba/b';
  const height = Number(quality);
  if (![360, 720, 1080, 1440, 2160].includes(height)) {
    throw new Error('Choose a valid quality.');
  }
  return `bv*[height<=${height}]+ba/b[height<=${height}]`;
}

async function downloadMedia(req, res) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    sendJson(res, 429, { error: 'The downloader is busy. Try again in a moment.' });
    return;
  }

  const body = await readJsonBody(req);
  const mediaUrl = normalizeMediaUrl(body.url);
  const kind = body.kind === 'audio' ? 'audio' : 'video';
  const quality = String(body.quality || 'best');
  const selector = formatSelector(kind, quality);
  const title = sanitizeFilename(body.title);
  const jobId = crypto.randomBytes(12).toString('hex');
  const jobDir = path.join(os.tmpdir(), `catch-${jobId}`);
  await fs.mkdir(jobDir, { recursive: true });
  activeJobs += 1;

  try {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      '20',
      '--max-filesize',
      '2G',
      '-f',
      selector,
      '-P',
      jobDir,
      '-o',
      'media.%(ext)s'
    ];

    if (kind === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
    }
    args.push(mediaUrl);

    await runYtDlp(args, { timeout: JOB_TIMEOUT_MS, maxOutput: 2 * 1024 * 1024 });
    const files = (await fs.readdir(jobDir)).filter((name) => name.startsWith('media.'));
    if (!files.length) throw new Error('The download finished without producing a file.');

    const filePath = path.join(jobDir, files[0]);
    const stats = await fs.stat(filePath);
    const extension = path.extname(filePath).toLowerCase() || (kind === 'audio' ? '.mp3' : '.mp4');
    const mime = kind === 'audio' ? 'audio/mpeg' : extension === '.webm' ? 'video/webm' : 'video/mp4';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Content-Disposition': contentDisposition(`${title}${extension}`),
      'Cache-Control': 'no-store'
    });

    await pipeline(createReadStream(filePath), res);
  } finally {
    activeJobs -= 1;
    await fs.rm(jobDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150
    }).catch(() => {});
  }
}

async function serveStatic(requestPath, res) {
  const requested = requestPath === '/' ? '/index.html' : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    sendJson(res, 400, { error: 'Invalid URL.' });
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && requestUrl.pathname === '/api/inspect') {
      await inspectMedia(req, res);
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/download') {
      await downloadMedia(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(requestUrl.pathname, res);
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 400, { error: error.message || 'Something went wrong.' });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Catch is running at http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
