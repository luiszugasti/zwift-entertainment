/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CHANNEL_PATH_RE = /^\/(@[\w.\-%]+|c\/[\w.\-%]+|user\/[\w.\-%]+|channel\/UC[\w-]{22})$/;

/**
 * GET /api/channel-id?path=/@handle -> { channelId, title }
 * YouTube channel pages can't be fetched from the browser (no CORS), so the dev and preview
 * servers do the lookup. Only youtube.com channel paths are accepted.
 */
function channelResolver(): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/channel-id')) return next();
    const path = new URL(req.url, 'http://localhost').searchParams.get('path') ?? '';
    const reply = (status: number, body: string, type = 'text/plain') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.end(body);
    };
    if (!CHANNEL_PATH_RE.test(path)) return reply(400, 'Not a YouTube channel link.');
    try {
      const page = await fetch(`https://www.youtube.com${path}`, {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'Mozilla/5.0', Cookie: 'SOCS=CAI' },
      });
      if (page.status === 404) return reply(404, 'YouTube has no channel at that link.');
      const html = await page.text();
      const id =
        html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
        html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
      if (!id) return reply(502, "Couldn't find the channel ID on YouTube's page.");
      const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
      reply(200, JSON.stringify({ channelId: id, title }), 'application/json');
    } catch {
      reply(502, "Couldn't reach YouTube.");
    }
  };
  return {
    name: 'channel-resolver',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID_RE = /^\d+$/;

/**
 * intervals.icu, for loading today's planned workout:
 *   GET /api/intervals/events?date=YYYY-MM-DD   -> planned workouts that day
 *   GET /api/intervals/workout?id=123           -> that workout as .zwo text
 * The browser sends the user's API key in an X-Intervals-Key header; it's forwarded with Basic
 * auth (user "API_KEY") to the athlete the key belongs to (athlete id 0). Going through this
 * server avoids relying on CORS, and only these two read-only calls are possible.
 */
function intervalsProxy(): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/intervals/')) return next();
    const url = new URL(req.url, 'http://localhost');
    const reply = (status: number, body: string, type = 'text/plain') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    };
    const key = req.headers['x-intervals-key'];
    if (typeof key !== 'string' || !key.trim()) return reply(401, 'Missing intervals.icu API key.');

    let target: string;
    if (url.pathname === '/api/intervals/events') {
      const date = url.searchParams.get('date') ?? '';
      if (!DATE_RE.test(date)) return reply(400, 'Bad date.');
      target = `https://intervals.icu/api/v1/athlete/0/events?oldest=${date}&newest=${date}`;
    } else if (url.pathname === '/api/intervals/workout') {
      const id = url.searchParams.get('id') ?? '';
      if (!EVENT_ID_RE.test(id)) return reply(400, 'Bad workout id.');
      target = `https://intervals.icu/api/v1/athlete/0/events/${id}/download.zwo`;
    } else {
      return reply(404, 'Not found.');
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          Authorization: `Basic ${Buffer.from(`API_KEY:${key.trim()}`).toString('base64')}`,
          'User-Agent': 'Mozilla/5.0 (RideReel)',
          Accept: url.pathname.endsWith('events') ? 'application/json' : '*/*',
        },
      });
      const body = await upstream.text();
      if (upstream.status === 401 || upstream.status === 403) {
        return reply(401, 'intervals.icu rejected the API key.');
      }
      if (!upstream.ok) return reply(502, `intervals.icu returned ${upstream.status}.`);
      reply(200, body, upstream.headers.get('content-type') ?? 'text/plain');
    } catch {
      reply(502, "Couldn't reach intervals.icu.");
    }
  };
  return {
    name: 'intervals-proxy',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

export default defineConfig({
  plugins: [react(), channelResolver(), intervalsProxy()],
  test: {
    environment: 'jsdom',
  },
});
