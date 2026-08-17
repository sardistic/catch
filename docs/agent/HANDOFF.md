# Agent Handoff

Updated: 2026-08-17

## Active objective

Let Catch save Instagram photo posts — single images and multi-image carousels — which `yt-dlp` refuses with "No video formats found".

## Completed work

- Photo posts are extracted by running `yt-dlp` with `--ignore-no-formats-error`. Its Instagram extractor reads the post fine and lists every carousel image under `thumbnails`; it only refuses to *emit* an entry that has no video formats. The last thumbnail of each entry is the uncropped original.
- Two direct-HTTP fallbacks remain if `yt-dlp` returns nothing: the web v1 API (`/api/v1/media/<pk>/info/`, the useful path once `INSTAGRAM_COOKIE` is set) and the `/embed/captioned/` page.
- Added `/api/asset` (HMAC-signed, 6-hour, CDN-host-restricted media proxy) and `/api/gallery-zip` (store-only ZIP written by hand, no dependencies).
- Added a gallery view in the front end: thumbnail grid, per-item Save, and Download all.
- Deployed to `/srv/catch` on the production host and verified live.

## Current behavior

- Instagram `/p/`, `/reel/`, `/tv/` links are extracted first. A gallery response is returned when the post has more than one item or any image.
- A single-video Instagram post still goes through the normal `yt-dlp` path (quality and audio options), falling back to the gallery if that fails.
- All other platforms are untouched — the `yt-dlp` inspect/download path is unchanged apart from a new `type: 'video'` field.
- Optional `INSTAGRAM_COOKIE` env var supplies a logged-in session; not set in production.

## Validation

- `npm run check`.
- The user's own post (`/p/CW80wZBPh97/`, 5 images) extracted end to end: gallery lists 5 photos by `@emmasmyspace`, and `/api/gallery-zip` returned a valid archive of five 1440x1800 JPEGs (verified with `zipfile.testzip()` and PIL).
- Earlier stubbed-`fetch` runs covered the fallback strategies, tampered-token rejection (400), and a 10-item zip.
- Browser-driven check (Playwright) of the real post: grid renders, Save yields `<shortcode>-01.jpg`, Download all yields `instagram-<shortcode>.zip`.
- YouTube inspect re-checked live for regression.

## Uncommitted implementation details

The yt-dlp-first rewrite is uncommitted: modified `server.js`, `README.md`, `docs/agent/*`. The earlier gallery work is committed and deployed as `30472e1`. Generated Git state is in `.agent/runtime/WORKTREE.md`.

## Risks and unknowns

- Photo support now depends on a **current** `yt-dlp` in the image. The 2025.11 build on the desktop cannot reach Instagram at all; the container's build (2026.07) can. A stale rebuild would silently lose photo support.
- Hand-written calls to Instagram's own API/GraphQL endpoints proved short-lived — the first version's `doc_id` was already dead — so treat the direct fallbacks as best-effort.
- Zip bundling buffers one file at a time in memory, capped at 120 MB per file and 600 MB per post.

## Next concrete action

Commit and push the yt-dlp-first extraction, then redeploy `/srv/catch` (`git -C /srv/catch/repo pull --ff-only`, `docker compose up -d --build`) and re-test the post through `https://catch.sardistic.com`.

## Deployment and status impact

`30472e1` is live on `catch.sardistic.com` (container `catch-app-1`, healthy; public probe returns 200). That deployed revision still fails on photo posts — the fix in the working tree is what makes them work, so a second deploy is required. No new dependencies or configuration; `INSTAGRAM_COOKIE` remains optional and unset.

## Most relevant files

- `server.js` — extraction strategies, asset signing/proxy, ZIP writer.
- `public/app.js` — gallery rendering and download handlers.
- `public/styles.css` — `.gallery*` rules.
