import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { capabilities } from './server/model-config.mjs';
import { createDesignService } from './server/image-service.mjs';
import { streamChat, stopChat } from './server/chat-service.mjs';
import { geometryCapabilities } from './server/geometry-service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const designs = createDesignService(root);
await designs.ready;
const dist = resolve(root, 'dist');
const dataDir = resolve(root, 'data/uploads');
const port = Number(process.env.PORT || 4174);
await mkdir(dataDir, { recursive: true });
const requests = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.stl': 'model/stl', '.wasm': 'application/wasm' };
const csp = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'";
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('文件大小超过本地 30 MiB 限制'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = decodeURIComponent(url.pathname);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/__local/health') return json(res, { ok: true, mode: 'local-design', productionApiConnected: false, models: {...capabilities(),...geometryCapabilities()} });
    if (path === '/__local/requests') return json(res, [...requests].map(([request, count]) => ({ request, count })));
    if (path.startsWith('/v1/') || path.startsWith('/api/')) {
      if (req.headers.origin && req.headers.origin !== url.origin) return json(res, { code: 40301, msg: '仅允许本地站点调用', data: null }, 403);
      const pathname = path.replace(/^\/v1/, '');
      const key = `${req.method} ${pathname}`;
      requests.set(key, (requests.get(key) || 0) + 1);
      const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      let body = null; try { body = raw?.length ? JSON.parse(raw.toString()) : null; } catch {}
      if (pathname === '/api/chat/sse/stream') {
        if (req.method !== 'POST') return json(res, { code: 40501, msg: '请使用 POST' }, 405);
        return await streamChat(body, res);
      }
      const stop = pathname.match(/^\/api\/chat\/sse\/stop\/([^/]+)$/);
      if (stop && req.method === 'POST') { stopChat(stop[1]); return json(res, { code: 0, data: null }); }
      if (['/api/upload/uploadDraw', '/api/upload/merChantupload'].includes(pathname) && req.method === 'POST') {
        const form = await new Request('http://local/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function') return json(res, { code: 40001, msg: '请选择本地图片', data: null });
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[file.type];
        if (!ext) return json(res, { code: 40002, msg: '本地预览支持 PNG/JPEG/WEBP/SVG', data: null });
        const name = randomUUID() + ext;
        await writeFile(resolve(dataDir, name), Buffer.from(await file.arrayBuffer()));
        const fileUrl = `http://127.0.0.1:${port}/uploads/${name}`;
        return json(res, { code: 0, msg: '图片已保存至本地', data: { url: fileUrl, src: fileUrl, fileToken: fileUrl, fileName: file.name } });
      }
      const designed = await designs.handle({ pathname, query: url.searchParams, method: req.method, body, origin: url.origin });
      if (designed) return json(res, designed);
      const revision = Math.max((await stat(resolve(root, 'server/fixtures.mjs'))).mtimeMs, (await stat(resolve(root, 'server/public-data.json'))).mtimeMs);
      const { handleLocalApi } = await import(`./server/fixtures.mjs?revision=${revision}`);
      return json(res, await handleLocalApi({ pathname, query: url.searchParams, method: req.method, body, origin: url.origin }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const uploads = path.startsWith('/uploads/'), generated = path.startsWith('/generated/');
    const base = uploads ? dataDir : generated ? resolve(root, 'data/generated') : dist;
    let file = resolve(base, uploads ? path.slice('/uploads/'.length) : generated ? path.slice('/generated/'.length) : '.' + (path === '/' ? '/index.html' : path));
    if (relative(base, file).startsWith('..')) { res.writeHead(404).end(); return; }
    try { if (!(await stat(file)).isFile()) throw new Error('not-file'); }
    catch { if (!uploads && !generated && !extname(path)) file = resolve(dist, 'index.html'); else { res.writeHead(404).end('Not found'); return; } }
    const info = await stat(file);
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0, end = info.size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    res.writeHead(range ? 206 : 200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD' || info.size === 0) res.end();
    else createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } catch (error) { json(res, { code: 50001, msg: error.message, data: null }, 500); }
});
server.on('error', e => { console.error(e.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`创觉珠宝 AI 本地版：http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
