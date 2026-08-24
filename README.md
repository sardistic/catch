# Catch

A small local web app for saving public videos and shorts from YouTube, X/Twitter, Instagram, and TikTok.

Instagram posts that hold photos — including multi-image carousels, which `yt-dlp` cannot read — are shown as a gallery instead: save any single item, or bundle the whole post into a zip.

A YouTube playlist link is listed as its tracks: tick the ones you want and take them as a zip of MP3s, or save any single track on its own. A video link that carries a `list=` still opens as that one video, with an offer to load the playlist behind it. Batches are capped at 50 tracks and 600 MB; anything unreachable is recorded in `skipped-tracks.txt` inside the zip rather than failing the whole batch.

## Requirements

- Node.js 18+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
- FFmpeg (needed for high-resolution video merges and MP3 conversion)

## Run

```powershell
npm start
```

Then open <http://127.0.0.1:3000>.

### Instagram access

Photo posts are read through `yt-dlp` (with `--ignore-no-formats-error`, since an image post has no video formats), so keep it current — older builds cannot reach Instagram at all. If posts still fail with "private or rate-limited", set a cookie header from a logged-in browser session:

```powershell
$env:INSTAGRAM_COOKIE = "sessionid=…; csrftoken=…"
npm start
```

## Container

```powershell
docker build -t catch .
docker run --rm -p 3000:3000 catch
```

Catch only accepts supported platform URLs, limits concurrent jobs, and deletes temporary files after each response. Instagram media is proxied through `/api/asset`, which only accepts HMAC-signed, short-lived links to Instagram's own CDN hosts, so it cannot be used as an open proxy. Only download media you own or have permission to save. Platform terms and copyright rules still apply.
