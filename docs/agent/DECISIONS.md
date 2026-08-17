# Project Decisions

Record durable architectural and operational decisions here.

### 2026-08-17 — Extract Instagram photo posts without yt-dlp

Context: `yt-dlp` cannot return Instagram images at all. Its extractor discards carousel children that have no `video_versions`, so photo posts fail with "No video formats found".

Decision: Keep using `yt-dlp` to *reach* the post — it extracts the payload fine and lists every carousel image under `thumbnails`; it just refuses to emit an entry that has no video formats. Running it with `--ignore-no-formats-error` yields the images, and the last thumbnail of each entry is the uncropped original. Serve those CDN URLs through an HMAC-signed proxy (`/api/asset`) and bundle whole posts with a hand-written store-only ZIP writer, keeping the project dependency-free. Video-only posts still take the normal `yt-dlp` path for its quality and audio options.

Consequences: Instagram's own endpoints move constantly — hand-rolled API and GraphQL calls written against them broke within a day, while `yt-dlp` tracks them for us. Two direct fallbacks remain for when `yt-dlp` cannot help: the web v1 API (the useful path once `INSTAGRAM_COOKIE` is set) and the embed page. The trade is that photo support now depends on a current `yt-dlp` in the image. The proxy is restricted to Instagram CDN hostnames and short-lived signed links so it cannot be abused as an open proxy.

### Date — Decision title

Context:

Decision:

Consequences:
