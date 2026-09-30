import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const file = new URL('../國策檔案-介面打磨樣品.html', import.meta.url);
const port = Number(process.env.NATIONAL_FOCUS_POLISH_PORT || 4186);
createServer(async (request, response) => {
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(500).end('Preview unavailable');
  }
}).listen(port, '127.0.0.1', () => console.log(`Polish preview: http://127.0.0.1:${port}`));
