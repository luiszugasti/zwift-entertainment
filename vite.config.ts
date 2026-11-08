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

export default defineConfig({
  plugins: [react(), channelResolver()],
  test: {
    environment: 'jsdom',
  },
});
