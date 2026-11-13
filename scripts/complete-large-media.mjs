import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'evidence/public-content-manifest.json');
const manifest = JSON.parse(await readFile(path, 'utf8'));
let content = JSON.parse(await readFile(resolve(root, 'server/public-content.json'), 'utf8'));
const failed = manifest.failures.filter(x => x.error?.includes('50 MiB'));
const mapping = new Map();
for (let i = 0; i < failed.length; i += 2) {
  await Promise.all(failed.slice(i, i + 2).map(async f => {
    const temp = resolve(root, 'captured/media', randomUUID() + '.partial');
    try {
      const response = await fetch(f.source, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      let bytes = 0; const hash = createHash('sha256');
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } }), createWriteStream(temp));
      const sha256 = hash.digest('hex');
      const localPath = 'media/' + sha256.slice(0, 24) + extname(new URL(f.source).pathname);
      await rename(temp, resolve(root, 'captured', localPath));
      manifest.files.push({ path: localPath, source: f.source, bytes, sha256, contentType: response.headers.get('content-type') });
      manifest.totalBytes += bytes;
      mapping.set(f.source, '@@ORIGIN@@/' + localPath);
      mapping.set(new URL(f.source).pathname, '@@ORIGIN@@/' + localPath);
      console.log(`Saved ${localPath}: ${bytes} bytes`);
    } catch (e) { f.error = e.message; try { await unlink(temp); } catch {} }
  }));
}
function rewrite(value) {
  if (typeof value === 'string') return mapping.get(value) || value.replace(/((?:src|href)=["'])([^"']+)(["'])/g, (all, a, url, b) => mapping.has(url) ? a + mapping.get(url) + b : all);
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, rewrite(v)]));
  return value;
}
manifest.failures = manifest.failures.filter(f => !mapping.has(f.source));
content = rewrite(content);
await writeFile(path, JSON.stringify(manifest, null, 2));
await writeFile(resolve(root, 'server/public-content.json'), JSON.stringify(content, null, 2));
console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.totalBytes, remainingFailures: manifest.failures.length }));
