/**
 * Static server for peapod. No dependencies, no build step.
 *
 * There is nothing to compile: web/ is served exactly as it sits on disk, which is the
 * same guarantee the engine relies on — the file the parity tests prove is the file the
 * browser loads. In development it also watches web/ and pushes a reload over SSE.
 *
 * Usage:  npm run dev      (PORT and HOST honoured)
 */

import http from 'node:http';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./web/', import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const dev = process.env.NODE_ENV !== 'production';

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    const url = new URL(req.url || '/', `http://${host}`);
    const path = decodeURIComponent(url.pathname);

    if (dev && path === '/__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // A path with no extension is a page: /traders serves traders.html. Without this the
    // nav would have to carry .html into every link and every browser history entry.
    const asPage = path === '/' ? '/index.html' : (extname(path) ? path : `${path}.html`);
    const file = resolve(root, '.' + asPage);
    // Never serve outside web/, whatever the request says.
    if (file !== root.replace(/\/$/, '') && !file.startsWith(root.replace(/\/$/, '') + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(file);
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8`,
      'Content-Length': body.length,
      'Cache-Control': dev ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
    res.writeHead(missing ? 404 : 500);
    res.end(missing ? 'Not found' : 'Server error');
  }
});

if (dev) {
  let timer;
  watch(root, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of clients) client.write('data: reload\n\n');
    }, 80);
  });
}

server.listen(port, host, () => {
  console.log(`peapod on http://${host}:${port}`);
});

process.on('SIGTERM', () => {
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
});
