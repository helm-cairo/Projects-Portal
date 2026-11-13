// Tiny local web server for testing: node tools/serve.mjs  ->  http://localhost:8080/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
const root = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = resolve(join(root, p));
  if (!file.startsWith(root) || file.includes(sep + 'existing' + sep)) { res.writeHead(404); return res.end(); }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}/`));
