import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const content = JSON.parse(await readFile(resolve(root, 'server/public-content.json'), 'utf8'));
const media = JSON.parse(await readFile(resolve(root, 'evidence/public-content-manifest.json'), 'utf8'));
let seed = null; try { seed = JSON.parse(await readFile('/tmp/cjzb-public-task-probe.json', 'utf8')); } catch {}
const sourceMap = new Map(media.files.map(f => [f.source, '@@ORIGIN@@/' + f.path]));
const tasks = {}, sources = [], failures = [], files = [];
function filter(value) {
  if (Array.isArray(value)) return value.map(filter);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(token|access_token|refresh_token|password|api_key|apiKey|secret)$/i.test(k)).map(([k, v]) => [k, filter(v)]));
  return value;
}
function localize(value) {
  if (typeof value === 'string') return sourceMap.get(value) || sourceMap.get('https://cjzbai-1389715364.cos.ap-chengdu.myqcloud.com' + (value.startsWith('/') ? value : '/' + value)) || value;
  if (Array.isArray(value)) return value.map(localize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v)]));
  return value;
}
for (let i = 0; i < content.gallery.length; i += 4) {
  await Promise.all(content.gallery.slice(i, i + 4).map(async row => {
    const path = '/api/draw/getPublicTaskInfo/' + row.id;
    try {
      const r = seed?.path === path ? seed.response : await (await fetch('https://cjzbai.com/v1' + path, { signal: AbortSignal.timeout(20000) })).json();
      sources.push({ path, code: r.code, authentication: 'none; public use-parameters action only' });
      if (r.code !== 0 || !r.data) { failures.push({ path, code: r.code }); return; }
      const params = filter(JSON.parse(r.data.originalPromptJson || '{}'));
      const refs = new Set();
      function scan(value) { if (typeof value === 'string' && /^(https?:\/\/|\/).+\.(png|jpe?g|webp)(\?|$)/i.test(value)) refs.add(value); else if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === 'object') Object.values(value).forEach(scan); }
      scan(params);
      for (const ref of refs) {
        const source = ref.startsWith('http') ? ref : 'https://cjzbai-1389715364.cos.ap-chengdu.myqcloud.com' + ref;
        if (sourceMap.has(source)) continue;
        try {
          const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const buffer = Buffer.from(await response.arrayBuffer());
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const filePath = 'media/' + sha256.slice(0, 24) + extname(new URL(source).pathname);
          await writeFile(resolve(root, 'captured', filePath), buffer);
          sourceMap.set(source, '@@ORIGIN@@/' + filePath);
          files.push({ path: filePath, source, sha256, bytes: buffer.length });
        } catch (e) { failures.push({ source, error: e.message }); }
      }
      tasks[row.id] = { id: r.data.id, drawAppNumber: r.data.drawAppNumber, originalPromptJson: JSON.stringify(localize(params)), status: 8, output: null, publicPreview: row.imgUrl };
    } catch (e) { failures.push({ path, error: e.message }); }
  }));
}
await writeFile(resolve(root, 'server/public-tasks.json'), JSON.stringify({ tasks }, null, 2));
await writeFile(resolve(root, 'evidence/shared-params-manifest.json'), JSON.stringify({ sources, files, failures, note: 'Only publicly shared form parameters retained. No session IDs, account data, private histories or backend output metadata.' }, null, 2));
console.log(JSON.stringify({ tasks: Object.keys(tasks).length, referenceImages: files.length, failures: failures.length }));
