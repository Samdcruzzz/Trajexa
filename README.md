# Trajexa - ANPR & Trajectory Dashboard (Netlify edition)

```
trajexa/
├── netlify.toml                 Build + redirect config (/api/* -> function)
├── package.json
├── .env.example                 Names of the env vars to set (never commit real keys)
├── public/
│   └── index.html               Static frontend (Leaflet, Tailwind, Chart.js)
├── netlify/functions/
│   └── api.js                   Express API wrapped as one Netlify Function
└── data/                        cameras / trajectories / watchlist seed (bundled into the function)
```

## Deploy

1. Push this folder (the one containing `netlify.toml`) to GitHub as the repo root.
2. Netlify -> Add new site -> Import from Git. Settings are read from `netlify.toml`
   (publish dir `public`, functions dir `netlify/functions`); leave the build command empty.
3. Site settings -> Environment variables, add:
   `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `MAPTILER_API_KEY`, `MAPTILER_STYLE`,
   `MAP_CENTER_LAT`, `MAP_CENTER_LNG`, `MAP_ZOOM` (see `.env.example`).
4. Deploy, then open `https://<your-site>.netlify.app/api/health` - it should return `{"ok":true}`.

CLI alternative: `npm install`, then `npx netlify-cli login`, `npx netlify-cli init`, `npx netlify-cli deploy --prod`.

## Local development

`npm install` then `npm run dev` (runs `netlify dev`, serves the site and function together, and reads a local `.env`).

## What changed from the Express version

- `server.js` became `netlify/functions/api.js`; the static files are served by Netlify's CDN.
- The watchlist is stored in **Netlify Blobs** (seeded from `data/watchlist.json` on first use),
  because serverless functions cannot write to the project filesystem.
- The rate limit on `/api/ai/brief` is per warm function instance, so it is a soft limit.
- Netlify's default function timeout is 10 s; Gemini Flash normally answers well within that.

## Notes

- The watchlist has no login. Anyone with the URL can add/remove entries. Add authentication
  (e.g. Netlify Identity or a shared-secret header) before sharing the URL.
- `MAPTILER_API_KEY` is sent to the browser by design - restrict it to your Netlify domain in the MapTiler dashboard.
- Never commit `.env`. Rotate any key that has been shared in a zip or chat.
