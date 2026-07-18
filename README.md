# Catch

A small local web app for saving public videos and shorts from YouTube, X/Twitter, Instagram, and TikTok.

## Requirements

- Node.js 18+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
- FFmpeg (needed for high-resolution video merges and MP3 conversion)

## Run

```powershell
npm start
```

Then open <http://127.0.0.1:3000>.

## Container

```powershell
docker build -t catch .
docker run --rm -p 3000:3000 catch
```

Catch only accepts supported platform URLs, processes one item rather than playlists, limits concurrent jobs, and deletes temporary files after each response. Only download media you own or have permission to save. Platform terms and copyright rules still apply.
