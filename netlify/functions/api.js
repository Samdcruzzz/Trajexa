'use strict';
/**
 * Trajexa API — Express app wrapped as a single Netlify Function.
 * Static data is bundled at build time (esbuild inlines the JSON requires).
 * The watchlist is persisted in Netlify Blobs, because a function's filesystem
 * is read-only / ephemeral.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const serverless = require('serverless-http');
const { getStore, connectLambda } = require('@netlify/blobs');

const CAMERAS = require('../../data/cameras.json');
const TRAJECTORIES = require('../../data/trajectories.json');
const WATCHLIST_SEED = require('../../data/watchlist.json');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

/* ------------------------------ helpers ------------------------------ */
// Strip characters that could break out of HTML when the frontend renders text.
const clean = (v, max = 120) => String(v ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, max);
const PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{2,14}$/;
const normPlate = (p) => String(p ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/* --------------------------- watchlist storage --------------------------- */
// Netlify Blobs in production / `netlify dev`; in-memory fallback if Blobs is unavailable.
let memoryWatchlist = null;
const blobStore = () => { try { return getStore('trajexa'); } catch (_) { return null; } };

async function loadWatchlist() {
  const store = blobStore();
  if (store) {
    try {
      const saved = await store.get('watchlist', { type: 'json' });
      if (Array.isArray(saved)) return saved;
      await store.setJSON('watchlist', WATCHLIST_SEED); // first run: seed from data/watchlist.json
      return [...WATCHLIST_SEED];
    } catch (e) { console.warn('Blobs unavailable, using in-memory watchlist:', e.message); }
  }
  if (!memoryWatchlist) memoryWatchlist = [...WATCHLIST_SEED];
  return memoryWatchlist;
}

async function saveWatchlist(list) {
  const store = blobStore();
  if (store) {
    try { await store.setJSON('watchlist', list); return; }
    catch (e) { console.warn('Blobs write failed, using in-memory watchlist:', e.message); }
  }
  memoryWatchlist = list;
}

/* -------------------------------- routes -------------------------------- */
const api = express.Router();

api.get('/health', (_req, res) => res.json({ ok: true }));

api.get('/config', (_req, res) => {
  res.json({
    mapTilerKey: process.env.MAPTILER_API_KEY || '',
    mapStyle: process.env.MAPTILER_STYLE || 'streets-v2-dark',
    center: {
      lat: Number(process.env.MAP_CENTER_LAT) || 28.608,
      lng: Number(process.env.MAP_CENTER_LNG) || 77.209
    },
    zoom: Number(process.env.MAP_ZOOM) || 12,
    aiEnabled: Boolean(process.env.GEMINI_API_KEY)
  });
});

api.get('/cameras', (_req, res) => res.json(CAMERAS));

api.get('/watchlist', async (_req, res, next) => {
  try { res.json(await loadWatchlist()); } catch (e) { next(e); }
});

api.post('/watchlist', async (req, res, next) => {
  try {
    const plate = normPlate(req.body && req.body.plate);
    if (!PLATE_RE.test(plate)) return res.status(400).json({ error: 'Invalid registration number.' });
    const list = await loadWatchlist();
    if (list.some((w) => w.plate === plate)) return res.status(409).json({ error: 'Plate already on watchlist.' });
    const entry = {
      plate,
      reason: clean(req.body.reason) || 'Investigation Flag',
      added: new Date().toISOString().slice(0, 10),
      status: clean(req.body.status, 30) || 'ACTIVE HUNT',
      priority: ['HIGH', 'MED', 'LOW'].includes(req.body.priority) ? req.body.priority : 'HIGH'
    };
    await saveWatchlist([entry, ...list]);
    res.status(201).json(entry);
  } catch (e) { next(e); }
});

api.delete('/watchlist/:plate', async (req, res, next) => {
  try {
    const plate = normPlate(req.params.plate);
    const list = await loadWatchlist();
    const remaining = list.filter((w) => w.plate !== plate);
    if (remaining.length === list.length) return res.status(404).json({ error: 'Not found.' });
    await saveWatchlist(remaining);
    res.status(204).end();
  } catch (e) { next(e); }
});

api.get('/trajectories', (_req, res) => res.json(TRAJECTORIES));

api.get('/trajectory/:plate', (req, res) => {
  const plate = normPlate(req.params.plate);
  if (!PLATE_RE.test(plate)) return res.status(400).json({ error: 'Invalid registration number.' });
  if (TRAJECTORIES[plate]) return res.json(TRAJECTORIES[plate]);

  // Demo behaviour: synthesize a plausible route from 4 random cameras.
  const cams = [...CAMERAS].sort(() => 0.5 - Math.random()).slice(0, 4);
  res.json({
    plate, type: 'Query Reconstructed Vehicle', dist: '12.4 km', duration: '29 mins', speed: '25.6 km/h',
    nodes: cams.map((c, i) => ({
      cam: c.id, name: c.name, time: `09:${15 + i * 7}:22 IST`,
      dir: i % 2 === 0 ? 'South-East' : 'Radial Inflow',
      speed: `${22 + Math.floor(Math.random() * 20)} km/h`,
      conf: `${(92 + Math.random() * 7).toFixed(1)}%`,
      lat: c.lat, lng: c.lng, delta: i === 0 ? 'Origin' : `+${i * 7}m`
    }))
  });
});

/* ------------------------- Gemini investigator brief ------------------------- */
// Note: limits are per warm function instance (in-memory), so this is a soft limit.
const aiLimiter = rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-nf-client-connection-ip'] || req.ip,
  validate: false,
  message: { error: 'Too many AI requests. Try again in a minute.' }
});

api.post('/ai/brief', aiLimiter, async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'Gemini is not configured. Set GEMINI_API_KEY in Netlify environment variables.' });

  const t = req.body && req.body.trajectory;
  if (!t || !Array.isArray(t.nodes) || t.nodes.length === 0 || t.nodes.length > 30) {
    return res.status(400).json({ error: 'A trajectory with 1-30 nodes is required.' });
  }

  const sightings = t.nodes.map((n, i) =>
    `${i + 1}. ${clean(n.time, 30)} | ${clean(n.name)} (${clean(n.cam, 20)}) | heading ${clean(n.dir, 40)} | ${clean(n.speed, 20)} | OCR confidence ${clean(n.conf, 10)}`
  ).join('\n');

  const prompt =
`You are a traffic-intelligence analyst assisting a police control room.
Write a brief of at most 120 words in plain text (no markdown) for the vehicle below.
Cover: the route in order, the direction of travel, any notable slowdowns or low-confidence reads, and one suggested next action.
Use ONLY the data given. Do not invent locations, people or facts.

Plate: ${clean(t.plate, 20)}
Category: ${clean(t.type, 60)}
Total distance: ${clean(t.dist, 20)} | Duration: ${clean(t.duration, 20)} | Average speed: ${clean(t.speed, 20)}
Sightings:
${sightings}`;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 400 }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Gemini error:', r.status, data && data.error && data.error.message);
      return res.status(502).json({ error: 'Gemini request failed. Check your API key and model name.' });
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
    if (!text) return res.status(502).json({ error: 'Gemini returned an empty response.' });
    res.json({ brief: text });
  } catch (e) {
    console.error('Gemini fetch failed:', e.message);
    res.status(502).json({ error: 'Could not reach Gemini.' });
  }
});

/* ------------------------------- mounting ------------------------------- */
// Netlify may hand the function either the original /api/... path or the
// rewritten /.netlify/functions/api/... path, so serve both.
app.use(['/api', '/.netlify/functions/api'], api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const expressHandler = serverless(app);

exports.handler = async (event, context) => {
  try { connectLambda(event); } catch (_) { /* not running on Netlify — in-memory fallback */ }
  return expressHandler(event, context);
};

exports.app = app; // for local testing
