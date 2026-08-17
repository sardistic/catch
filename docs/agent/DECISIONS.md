# Project Decisions

Record durable architectural and operational decisions here.

### 2026-08-17 — Extract Instagram photo posts without yt-dlp

Context: `yt-dlp` cannot return Instagram images at all. Its extractor discards carousel children that have no `video_versions`, so photo posts fail with "No video formats found".

Decision: Talk to Instagram directly from `server.js` for `/p/`, `/reel/`, and `/tv/` links, trying the web v1 API, then GraphQL, then the embed page. Serve the resulting CDN URLs through an HMAC-signed proxy (`/api/asset`) and bundle whole posts with a hand-written store-only ZIP writer, keeping the project dependency-free. Video-only posts still prefer `yt-dlp` for its quality and audio options.

Consequences: Instagram's private endpoints can change shape or throttle by IP, so the strategy chain and the optional `INSTAGRAM_COOKIE` env var exist as hedges. The proxy is restricted to Instagram CDN hostnames and short-lived signed links so it cannot be abused as an open proxy.

### Date — Decision title

Context:

Decision:

Consequences:
