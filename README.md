# SF Web TRSS Web

Standalone static web frontend split from `sf-web-adapter/web/public`.

## Deploy

- Netlify publish directory: repository root (`.`)
- Vercel config: `vercel.json`
- Build command: none

The frontend is static HTML/CSS/JavaScript. WebSocket proxy handling lives in
`js/app.js`, including the HTTPS proxy endpoints for domain and numeric IP
server addresses.
