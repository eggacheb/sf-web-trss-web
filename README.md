# SF Web TRSS Web

Standalone static web frontend split from `sf-web-adapter/web/public`.

## Deploy

- Netlify publish directory: repository root (`.`)
- Vercel config: `vercel.json`
- Build command: none

The frontend is static HTML/CSS/JavaScript. WebSocket proxy handling lives in
`js/app.js`, including the HTTPS proxy endpoints for domain and numeric IP
server addresses.

## Media cache

Live images and audio are cached in IndexedDB (`sf_chat_media_cache`), scoped by
WebSocket host, port and `userQQ`.

When replaying history, messages that only carry `[图片]` / `[语音]` placeholders
are restored in two steps:

1. From the local IndexedDB cache — fast path, survives a page refresh.
2. On a cache miss, by requesting the media from the adapter over the existing
   WebSocket: `{ "type": "getMedia", "userQQ": "...", "id": "..." }`.

Step 2 is what makes messages received while the page was closed recoverable:
the adapter keeps media on disk for `media_retention_days` (default 14) and
prunes the oldest files once the directory exceeds `media_max_size_mb`.

Clearing the conversation removes both the server-side media directory and the
browser cache, so a cleared chat leaves nothing behind.
