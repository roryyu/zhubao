import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let seed = []; try { seed = JSON.parse(await readFile('/tmp/cjzb-public-content-probe.json', 'utf8')); } catch {}
const sources = [], failures = [];
async function get(path) {
  const response = seed.find(r => r.path === path)?.response || await (await fetch('https://cjzbai.com/v1' + path, { signal: AbortSignal.timeout(20000) })).json();
  sources.push({ path, code: response.code, authentication: 'none' });
  if (response.code !== 0) { failures.push({ path, code: response.code }); return { list: [], total: 0 }; }
  return response.data;
}
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object[k] !== undefined).map(k => [k, object[k]]));
const modelData = await get('/api/aiModel/page?classId=0&page=1&limit=50');
const models = modelData.list.map(x => pick(x, ['id', 'modelTitle', 'modelImg', 'modelCall', 'className', 'answerTemperature', 'chatMode', 'isOpen', 'isUseKnowledge']));
const firstTutorials = await get('/api/news/page?page=1&limit=12&classId=0');
const tutorialRows = [...firstTutorials.list];
for (let page = 2; (page - 1) * 12 < firstTutorials.total; page++) tutorialRows.push(...(await get(`/api/news/page?page=${page}&limit=12&classId=0`)).list);
const tutorials = tutorialRows.map(x => pick(x, ['id', 'title', 'summary', 'img', 'content', 'type', 'status', 'isSysRecommend', 'browseCount', 'collectCount', 'starCount', 'commentCount', 'createDate', 'tagIdList', 'sort']));
const firstGallery = await get('/api/draw/getPublicList?page=1&limit=20&order=desc&orderField=create_time');
const galleryRows = [...firstGallery.list];
for (let page = 2; (page - 1) * 20 < firstGallery.total; page++) galleryRows.push(...(await get(`/api/draw/getPublicList?page=${page}&limit=20&order=desc&orderField=create_time`)).list);
const gallery = galleryRows.map(x => pick(x, ['id', 'imgUrl', 'imgWidth', 'imgHeight', 'type', 'createTime', 'prompt', 'negativePrompt', 'nickName', 'avatar', 'starCount', 'browseCount', 'isStar', 'reqType', 'reqTypeName', 'taskId', 'isCanDrawSame', 'isRecommend', 'isBuy', 'billingMode', 'isOpenWatermark', 'watermarkPrice']));

// Only media already referenced by these explicitly public records. Uploaded
// source images, private histories, user IDs and session IDs are not retained.
const cos = 'https://cjzbai-1389715364.cos.ap-chengdu.myqcloud.com';
const refs = new Set();
for (const row of [...models, ...tutorials, ...gallery]) {
  for (const key of ['imgUrl', 'img', 'avatar', 'modelImg']) if (row[key]) refs.add(row[key]);
  for (const m of String(row.content || '').matchAll(/(?:src|href)=["']([^"']+)["']/g)) if (/\.(?:png|jpe?g|webp|gif|svg|mp4)(?:\?|$)/i.test(m[1])) refs.add(m[1]);
}
const map = {}, files = [];
await mkdir(resolve(root, 'captured/media'), { recursive: true });
const queue = [...refs];
let totalBytes = 0;
async function acquire(original) {
  if (original.startsWith('data:') || original.startsWith('blob:')) return;
  const url = original.startsWith('http') ? original : cos + (original.startsWith('/') ? original : '/' + original);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (Number(r.headers.get('content-length')) > 50 * 1024 * 1024) throw new Error('Public media exceeds 50 MiB capture limit');
    const bytes = Buffer.from(await r.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    const ext = extname(new URL(url).pathname).slice(0, 8) || '.bin';
    const path = 'media/' + hash.slice(0, 24) + ext;
    await writeFile(resolve(root, 'captured', path), bytes);
    map[original] = '@@ORIGIN@@/' + path;
    files.push({ path, source: url, bytes: bytes.length, sha256: hash, contentType: r.headers.get('content-type') });
    totalBytes += bytes.length;
  } catch (e) { failures.push({ source: url, error: e.message }); }
}
for (let i = 0; i < queue.length; i += 4) await Promise.all(queue.slice(i, i + 4).map(acquire));
function localize(value) {
  if (typeof value === 'string') {
    if (map[value]) return map[value];
    return value.replace(/((?:src|href)=["'])([^"']+)(["'])/g, (all, a, url, b) => map[url] ? a + map[url] + b : all);
  }
  if (Array.isArray(value)) return value.map(localize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v)]));
  return value;
}
const content = { capturedAt: new Date().toISOString(), provenance: 'Public unauthenticated content listings and their explicitly referenced media. No private account or source-upload records.', ...localize({ models, tutorials, gallery }) };
await writeFile(resolve(root, 'server/public-content.json'), JSON.stringify(content, null, 2));
await writeFile(resolve(root, 'evidence/public-content-manifest.json'), JSON.stringify({ sources, files, failures, totalBytes }, null, 2));
console.log(JSON.stringify({ models: models.length, tutorials: tutorials.length, gallery: gallery.length, media: files.length, totalBytes, failures: failures.length }));
