const http = require('node:http');
const { spawn } = require('node:child_process');
const { createReadStream, promises: fs } = require('node:fs');
const { Readable } = require('node:stream');
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

const INSTAGRAM_APP_ID = '936619743392459';
const INSTAGRAM_COOKIE = process.env.INSTAGRAM_COOKIE || '';
const BROWSER_UA =
  process.env.BROWSER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ASSET_SECRET = crypto.randomBytes(32);
const ASSET_TTL_MS = 6 * 60 * 60 * 1000;
const ASSET_HOST_PATTERN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;
const MAX_ASSET_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_BYTES = 600 * 1024 * 1024;

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

function instagramShortcode(mediaUrl) {
  const parsed = new URL(mediaUrl);
  if (!/(^|\.)instagram\.com$/.test(parsed.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const match = parsed.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,32})/);
  return match ? match[1] : null;
}

let instagramSession = { cookie: '', expires: 0 };

async function instagramCookie() {
  if (INSTAGRAM_COOKIE) return INSTAGRAM_COOKIE;
  if (instagramSession.expires > Date.now()) return instagramSession.cookie;

  let cookie = '';
  try {
    const response = await fetch('https://www.instagram.com/', {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12_000)
    });
    cookie = (response.headers.getSetCookie?.() || [])
      .map((entry) => entry.split(';')[0])
      .filter(Boolean)
      .join('; ');
  } catch {
    cookie = '';
  }

  instagramSession = { cookie, expires: Date.now() + (cookie ? 10 * 60 * 1000 : 60 * 1000) };
  return cookie;
}

async function instagramHeaders(referer) {
  const cookie = await instagramCookie();
  const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  return {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'X-CSRFToken': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
    ...(cookie ? { Cookie: cookie } : {})
  };
}

async function instagramJson(requestUrl, referer) {
  const response = await fetch(requestUrl, {
    headers: await instagramHeaders(referer),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

function bestCandidate(candidates) {
  return [...(candidates || [])]
    .filter((candidate) => typeof candidate?.url === 'string')
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
}

// Instagram's API and GraphQL responses describe carousel children differently;
// both collapse into the same { kind, url, width, height, preview } shape.
function fromApiMedia(media) {
  const video = bestCandidate(media.video_versions);
  const image = bestCandidate(media.image_versions2?.candidates);
  if (video) {
    return { kind: 'video', url: video.url, width: video.width, height: video.height, preview: image?.url };
  }
  if (image) {
    return { kind: 'image', url: image.url, width: image.width, height: image.height, preview: image.url };
  }
  return null;
}

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function shortcodeToPk(shortcode) {
  let value = 0n;
  for (const character of shortcode.slice(0, 11)) {
    const index = SHORTCODE_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = value * 64n + BigInt(index);
  }
  return value.toString();
}

async function instagramViaApi(shortcode) {
  const pk = shortcodeToPk(shortcode);
  if (!pk) return null;

  const payload = await instagramJson(
    `https://www.instagram.com/api/v1/media/${pk}/info/`,
    `https://www.instagram.com/p/${shortcode}/`
  );
  const post = payload?.items?.[0];
  if (!post) return null;

  const children = post.carousel_media?.length ? post.carousel_media : [post];
  const items = children.map(fromApiMedia).filter(Boolean);
  if (!items.length) return null;

  return {
    items,
    creator: post.user?.username || post.user?.full_name || null,
    caption: post.caption?.text || null
  };
}

async function instagramViaEmbed(shortcode) {
  const response = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) return null;

  const html = await response.text();
  const urls = new Set();
  for (const match of html.matchAll(/"display_url":"(https:[^"]+)"/g)) {
    urls.add(JSON.parse(`"${match[1]}"`));
  }
  if (!urls.size) {
    const single = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
    if (single) urls.add(single[1].replace(/&amp;/g, '&'));
  }
  if (!urls.size) return null;

  const username = html.match(/"username":"([^"]+)"/);
  return {
    items: [...urls].map((url) => ({ kind: 'image', url, preview: url })),
    creator: username ? username[1] : null,
    caption: null
  };
}

function fromYtDlpEntry(entry) {
  // yt-dlp lists thumbnails smallest first, and the last one is the uncropped
  // original — for a photo that *is* the file we want.
  const preview = entry.thumbnail || entry.thumbnails?.at(-1)?.url || null;
  const video = (entry.formats || [])
    .filter((format) => typeof format.url === 'string' && /^https?:/.test(format.url))
    .filter((format) => !format.protocol || /^https?$/.test(format.protocol))
    .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))[0];

  if (video) {
    return {
      kind: 'video',
      url: video.url,
      width: Number(video.width) || null,
      height: Number(video.height) || null,
      preview
    };
  }
  if (!preview) return null;
  return { kind: 'image', url: preview, width: null, height: null, preview };
}

// yt-dlp reads Instagram's post payload but refuses to emit an image-only post
// unless told to ignore the missing formats; its thumbnails carry the images.
async function instagramViaYtDlp(shortcode, mediaUrl) {
  const output = await runYtDlp([
    '--dump-single-json',
    '--ignore-no-formats-error',
    '--skip-download',
    '--no-warnings',
    '--socket-timeout',
    '15',
    mediaUrl
  ]);

  const info = JSON.parse(output);
  const entries = info._type === 'playlist' ? info.entries || [] : [info];
  const items = entries.map(fromYtDlpEntry).filter(Boolean);
  if (!items.length) return null;

  return {
    items,
    creator: info.channel || info.uploader || null,
    caption: info.description || null
  };
}

async function extractInstagramPost(shortcode, mediaUrl) {
  const strategies = [instagramViaYtDlp, instagramViaApi, instagramViaEmbed];
  for (const strategy of strategies) {
    const post = await strategy(shortcode, mediaUrl).catch(() => null);
    if (post?.items?.length) return post;
  }
  return null;
}

function signAsset(url, filename) {
  const payload = Buffer.from(
    JSON.stringify({ u: url, n: filename, e: Date.now() + ASSET_TTL_MS }),
    'utf8'
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', ASSET_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAsset(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) throw new Error('This link is no longer valid.');

  const expected = crypto.createHmac('sha256', ASSET_SECRET).update(payload).digest('base64url');
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new Error('This link is no longer valid.');
  }

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.e || data.e < Date.now()) throw new Error('This link has expired. Look up the post again.');

  const assetUrl = new URL(data.u);
  if (assetUrl.protocol !== 'https:' || !ASSET_HOST_PATTERN.test(assetUrl.hostname.toLowerCase())) {
    throw new Error('This link is no longer valid.');
  }
  return { url: assetUrl.toString(), filename: data.n };
}

function assetExtension(url, kind) {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if (/^\.(jpg|jpeg|png|webp|heic|mp4|webm)$/.test(extension)) return extension;
  return kind === 'video' ? '.mp4' : '.jpg';
}

function buildGallery(post, shortcode, mediaUrl) {
  const creator = post.creator ? `@${post.creator}` : 'Unknown creator';
  const caption = (post.caption || '').split('\n')[0].trim();
  const title = caption ? caption.slice(0, 120) : `Instagram post by ${creator}`;

  const items = post.items.map((item, index) => {
    const position = String(index + 1).padStart(2, '0');
    const filename = `${shortcode}-${position}${assetExtension(item.url, item.kind)}`;
    const token = signAsset(item.url, filename);
    return {
      kind: item.kind,
      filename,
      width: Number(item.width) || null,
      height: Number(item.height) || null,
      preview: `/api/asset?token=${encodeURIComponent(signAsset(item.preview || item.url, filename))}`,
      download: `/api/asset?token=${encodeURIComponent(token)}&save=1`
    };
  });

  return {
    type: 'gallery',
    platform: 'Instagram',
    title,
    creator,
    shortcode,
    mediaUrl,
    imageCount: items.filter((item) => item.kind === 'image').length,
    videoCount: items.filter((item) => item.kind === 'video').length,
    items
  };
}

async function fetchAsset(assetUrl) {
  const response = await fetch(assetUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://www.instagram.com/',
      Accept: 'image/avif,image/webp,image/*,video/*,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok || !response.body) {
    throw new Error('Instagram would not hand over that file. Look up the post again.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_ASSET_BYTES) throw new Error('That file is too large to fetch.');
  return response;
}

async function serveAsset(requestUrl, res) {
  const { url, filename } = verifyAsset(requestUrl.searchParams.get('token'));
  const response = await fetchAsset(url);
  const extension = path.extname(filename).toLowerCase();

  res.writeHead(200, {
    'Content-Type': response.headers.get('content-type') || MIME_TYPES[extension] || 'application/octet-stream',
    'Cache-Control': 'private, max-age=600',
    ...(response.headers.get('content-length') ? { 'Content-Length': response.headers.get('content-length') } : {}),
    ...(requestUrl.searchParams.get('save') ? { 'Content-Disposition': contentDisposition(filename) } : {})
  });

  await pipeline(Readable.fromWeb(response.body), res);
}

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// Minimal store-only ZIP writer: image and video bytes are already compressed,
// so skipping deflate keeps this dependency-free without costing any size.
const ZIP_DATE = 20513; // 2020-01-01
const ZIP_FLAGS = 0x0800; // UTF-8 filenames

function zipLocalHeader(name, crc, size) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_FLAGS, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer]);
}

function zipCentralRecord(name, crc, size, offset) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(ZIP_FLAGS, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(0, 12);
  record.writeUInt16LE(ZIP_DATE, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(size, 20);
  record.writeUInt32LE(size, 24);
  record.writeUInt16LE(nameBuffer.length, 28);
  record.writeUInt32LE(offset, 42);
  return Buffer.concat([record, nameBuffer]);
}

function zipEndRecord(count, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

function writeChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    if (res.write(chunk)) {
      resolve();
      return;
    }
    res.once('drain', resolve);
    res.once('error', reject);
  });
}

async function downloadGalleryZip(req, res) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    sendJson(res, 429, { error: 'The downloader is busy. Try again in a moment.' });
    return;
  }

  const body = await readJsonBody(req);
  const mediaUrl = normalizeMediaUrl(body.url);
  const shortcode = instagramShortcode(mediaUrl);
  if (!shortcode) throw new Error('Paste an Instagram post link to download a whole post.');

  const post = await extractInstagramPost(shortcode, mediaUrl);
  if (!post) throw new Error('Could not read that post again. It may be private or rate-limited.');

  const gallery = buildGallery(post, shortcode, mediaUrl);
  activeJobs += 1;

  try {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${sanitizeFilename(`instagram-${shortcode}`)}.zip`),
      'Cache-Control': 'no-store'
    });

    const central = [];
    let offset = 0;

    for (const [index, item] of post.items.entries()) {
      const name = gallery.items[index].filename;
      const response = await fetchAsset(item.url);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_ASSET_BYTES || offset + data.length > MAX_ZIP_BYTES) {
        throw new Error('This post is too large to bundle.');
      }

      const crc = crc32(data);
      const header = zipLocalHeader(name, crc, data.length);
      await writeChunk(res, header);
      await writeChunk(res, data);
      central.push(zipCentralRecord(name, crc, data.length, offset));
      offset += header.length + data.length;
    }

    const directory = Buffer.concat(central);
    await writeChunk(res, directory);
    await writeChunk(res, zipEndRecord(central.length, directory.length, offset));
    res.end();
  } finally {
    activeJobs -= 1;
  }
}

async function inspectMedia(req, res) {
  const body = await readJsonBody(req);
  const mediaUrl = normalizeMediaUrl(body.url);
  const shortcode = instagramShortcode(mediaUrl);
  let gallery = null;

  if (shortcode) {
    const post = await extractInstagramPost(shortcode, mediaUrl).catch(() => null);
    if (post) gallery = buildGallery(post, shortcode, mediaUrl);
  }

  // A lone video is better served by yt-dlp, which offers quality and audio options.
  if (gallery && (gallery.items.length > 1 || gallery.items[0].kind === 'image')) {
    sendJson(res, 200, gallery);
    return;
  }

  try {
    await inspectVideo(mediaUrl, res);
  } catch (error) {
    if (gallery) {
      sendJson(res, 200, gallery);
      return;
    }
    if (shortcode && /no video formats|there is no video/i.test(error.message || '')) {
      throw new Error(
        'Could not read this Instagram post. It may be private, or Instagram is rate-limiting this server.'
      );
    }
    throw error;
  }
}

async function inspectVideo(mediaUrl, res) {
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
    type: 'video',
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
    if (req.method === 'POST' && requestUrl.pathname === '/api/gallery-zip') {
      await downloadGalleryZip(req, res);
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/asset') {
      await serveAsset(requestUrl, res);
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
