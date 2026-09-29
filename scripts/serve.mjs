import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname, join } from 'node:path';

const directory = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.NATIONAL_FOCUS_PORT || 4173);
const allowed = new Set([
  'index.html',
  'UI測試.html',
  'preview.js',
  'national-focus.js',
  '國策檔案-酒館助手.json',
]);
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    const name = pathname === '/' ? 'index.html' : basename(pathname);
    if (!allowed.has(name) || (pathname !== '/' && pathname !== `/${name}`)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(join(directory, name));
    response.writeHead(200, {
      'Content-Type': {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
      }[extname(name)],
      'Cache-Control': 'no-store',
    });
    response.end(data);
  } catch {
    response.writeHead(400).end('Invalid request');
  }
}).listen(port, '127.0.0.1', () => console.log(`國策 UI 測試：http://127.0.0.1:${port}`));
