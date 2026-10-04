// Serves only the standalone period prototype, without exposing project files.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = 4186;
const file = new URL('./分期國策-現有介面樣品.html', import.meta.url);
const server = createServer(async (request, response) => {
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const html = await readFile(file);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(html);
  } catch {
    response.writeHead(500).end('Unable to read the prototype.');
  }
});
server.on('error', error => {
  console.error(`Preview server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Period UI prototype: http://127.0.0.1:${port}/`);
});
