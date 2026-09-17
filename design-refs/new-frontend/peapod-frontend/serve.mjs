/** Dev server: serves this folder exactly as it sits. No build step, nothing to compile. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const path = decodeURIComponent(url.pathname);
  const asPage = path === '/' ? '/index.html' : (extname(path) ? path : `${path}.html`);
  const file = resolve(root, '.' + asPage);
  if (!file.startsWith(root.replace(/\/$/, '') + sep)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'text/plain'}; charset=utf-8`,
      'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.PORT || 4180), '127.0.0.1',
  () => console.log(`peapod frontend on http://127.0.0.1:${process.env.PORT || 4180}`));
