# Agent Handoff

Updated: 2026-08-17

## Active objective

Let Catch save Instagram photo posts — single images and multi-image carousels — which `yt-dlp` refuses with "No video formats found".

## Completed work

- Added an Instagram extractor to `server.js` that bypasses `yt-dlp` for photo posts. `yt-dlp`'s Instagram extractor drops non-video carousel children entirely (`_extract_product_media` returns `{}` when there is no `video_versions`), so image posts can never be read through it.
- Three extraction strategies are tried in order: the web v1 API (`/api/v1/media/<pk>/info/`, richest data), the GraphQL `doc_id=8845758582119845` query, then the `/embed/captioned/` page as a last resort.
- Added `/api/asset` (HMAC-signed, 6-hour, CDN-host-restricted media proxy) and `/api/gallery-zip` (store-only ZIP written by hand, no dependencies).
- Added a gallery view in the front end: thumbnail grid, per-item Save, and Download all.

## Current behavior

- Instagram `/p/`, `/reel/`, `/tv/` links are extracted first. A gallery response is returned when the post has more than one item or any image.
- A single-video Instagram post still goes through `yt-dlp` (quality and audio options), falling back to the gallery if `yt-dlp` fails.
- All other platforms are untouched — the `yt-dlp` inspect/download path is unchanged apart from a new `type: 'video'` field.
- Optional `INSTAGRAM_COOKIE` env var supplies a logged-in session when Instagram rate-limits the host.

## Validation

- `npm run check`.
- Full pipeline exercised against a stubbed `globalThis.fetch` (API payload, GraphQL fallback, single-video fallback): inspect, per-item proxy download, tampered-token rejection (400), and a 10-item zip verified with Python's `zipfile.testzip()`.
- Browser-driven check (Playwright): 3-item and 10-item carousels render, Save downloads `<shortcode>-01.jpg`, Download all downloads `instagram-<shortcode>.zip`.
- YouTube inspect re-checked live for regression.
- Live Instagram could not be reached from this machine: its IP is currently rate-limited ("Please wait a few minutes before you try again"), which also blocks `yt-dlp`.

## Uncommitted implementation details

Changes are unstaged in `server.js`, `public/app.js`, `public/index.html`, `public/styles.css`, `README.md`. Generated Git state is in `.agent/runtime/WORKTREE.md`.

## Risks and unknowns

- Instagram's `doc_id` and API shapes are undocumented and change; the three-strategy chain is the hedge.
- The embed fallback usually yields only the first image of a carousel.
- Zip bundling buffers one file at a time in memory, capped at 120 MB per file and 600 MB per post.

## Next concrete action

Try a real carousel from a host Instagram is not throttling; if it fails, set `INSTAGRAM_COOKIE`.

## Deployment and status impact

Nothing was deployed and nothing was committed — the work sits in the working tree on `main`. No new dependencies, no Dockerfile change, and no new required configuration: `INSTAGRAM_COOKIE` is optional and the app runs without it. When this does ship, the only operational note is that the host's IP now talks to Instagram directly (previously only `yt-dlp` did), so per-IP throttling affects photo posts as well as videos.

## Most relevant files

- `server.js` — extraction strategies, asset signing/proxy, ZIP writer.
- `public/app.js` — gallery rendering and download handlers.
- `public/styles.css` — `.gallery*` rules.
