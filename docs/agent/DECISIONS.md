# Project Decisions

Record durable architectural and operational decisions here.

### 2026-08-17 — Extract Instagram photo posts without yt-dlp

Context: `yt-dlp` cannot return Instagram images at all. Its extractor discards carousel children that have no `video_versions`, so photo posts fail with "No video formats found".

Decision: Keep using `yt-dlp` to *reach* the post — it extracts the payload fine and lists every carousel image under `thumbnails`; it just refuses to emit an entry that has no video formats. Running it with `--ignore-no-formats-error` yields the images, and the last thumbnail of each entry is the uncropped original. Serve those CDN URLs through an HMAC-signed proxy (`/api/asset`) and bundle whole posts with a hand-written store-only ZIP writer, keeping the project dependency-free. Video-only posts still take the normal `yt-dlp` path for its quality and audio options.

Consequences: Instagram's own endpoints move constantly — hand-rolled API and GraphQL calls written against them broke within a day, while `yt-dlp` tracks them for us. Two direct fallbacks remain for when `yt-dlp` cannot help: the web v1 API (the useful path once `INSTAGRAM_COOKIE` is set) and the embed page. The trade is that photo support now depends on a current `yt-dlp` in the image. The proxy is restricted to Instagram CDN hostnames and short-lived signed links so it cannot be abused as an open proxy.

### 2026-08-23 — Stream playlist batches as a zip instead of queueing a job

Context: A playlist batch is minutes of work — every track is a separate `yt-dlp` run plus an FFmpeg transcode — so the obvious shapes are a job queue with a progress endpoint, or one long request.

Decision: Keep the request. `/api/playlist-zip` writes the response headers immediately and appends each MP3 to a store-only zip as soon as that track finishes, so bytes keep flowing and no proxy sees an idle connection. Listing is a separate, fast step: `--flat-playlist` reads a whole playlist in one request, and the front end sends back the indexes it wants. Because the zip is already streaming when a track fails, a failure cannot become an error response — the track is recorded in `skipped-tracks.txt` inside the archive and the batch carries on.

Consequences: No job store, no polling, no server state — the same shape as the Instagram gallery zip, which now shares the writer. The cost is that the reader gets no per-track progress and cannot resume a batch, so batches are capped at 50 tracks (600 MB) and listings at 200 entries. A dropped connection loses the whole batch, which is why single tracks are also downloadable on their own.

### Date — Decision title

Context:

Decision:

Consequences:
