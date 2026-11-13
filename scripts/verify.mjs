import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = ['evidence/public-assets/asset-manifest.json', 'evidence/public-content-manifest.json', 'evidence/shared-params-manifest.json', 'evidence/ui-config-assets.json'];
const entries = new Map();
for (const path of manifests) for (const f of JSON.parse(await readFile(resolve(root, path), 'utf8')).files) entries.set(f.path, f);
const patches = new Map(JSON.parse(await readFile(resolve(root, 'evidence/local-patches.json'), 'utf8')).changes.map(p => [p.path, p]));
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
let bytes = 0;
for (const entry of entries.values()) {
  assert.equal(await digest(resolve(root, 'captured', entry.path)), entry.sha256, `Captured hash: ${entry.path}`);
  assert.equal(await digest(resolve(root, 'dist', entry.path)), patches.get(entry.path)?.localSha256 || entry.sha256, `Local hash: ${entry.path}`);
  bytes += entry.bytes;
}
const report = { capturedAssets: entries.size, capturedBytes: bytes, diskHashesVerified: true, adaptationPatches: patches.size };
const urlAt = process.argv.indexOf('--url');
if (urlAt !== -1) {
  const base = new URL(process.argv[urlAt + 1]);
  const api = async (path, options) => (await fetch(new URL('/v1' + path, base), options)).json();
  const health = await (await fetch(new URL('/__local/health', base))).json();
  assert.equal(health.productionApiConnected, false);
  const before = await api('/api/user/userInfo');
  const denied = await api('/api/unified/submit-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appNumber: 2018, params: { prompt: 'Local verification; unsupported video service only' } }) });
  assert.notEqual(denied.code, 0, 'Unconfigured generation must not report success');
  assert.equal(denied.data, null);
  assert.equal((await api('/api/user/userInfo')).data.msgCount, before.data.msgCount, 'Denied generation must not consume credits');
  let unconfiguredChatRejected = null;
  if (!health.models?.chat?.configured) {
    const chat = await fetch(new URL('/v1/api/chat/sse/stream', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'Local verification' }) });
    assert.ok(chat.headers.get('content-type').includes('text/event-stream'));
    const event = JSON.parse((await chat.text()).trim().replace(/^data: /, ''));
    assert.equal(event.error, true, 'Unconfigured chat must report an error, not a fabricated answer');
    unconfiguredChatRejected = true;
  }
  const form = new FormData();
  const sample = await readFile(resolve(root, 'captured/local/fallback-jewelry.jpg'));
  form.append('file', new Blob([sample], { type: 'image/jpeg' }), 'qa-reference.jpg');
  const uploaded = await api('/api/upload/uploadDraw', { method: 'POST', body: form });
  assert.equal(uploaded.code, 0);
  assert.equal(new URL(uploaded.data.url).origin, base.origin);
  const returned = Buffer.from(await (await fetch(uploaded.data.url)).arrayBuffer());
  assert.equal(createHash('sha256').update(returned).digest('hex'), createHash('sha256').update(sample).digest('hex'), 'Upload round trip');
  const video = [...entries.values()].find(f => f.path.endsWith('.mp4'));
  const range = await fetch(new URL('/' + video.path, base), { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  const policy = (await fetch(base)).headers.get('content-security-policy');
  assert.ok(policy.includes("connect-src 'self'"), 'Browser API requests must remain local');
  Object.assign(report, { httpVerified: true, localUploadRoundTrip: true, videoByteRange: true, unsupportedGenerationRejected: true, unconfiguredChatRejected, creditsUnchanged: true, browserConnectionsRestrictedToLocal: true, productionApiConnected: false, verificationUsesPaidModels: false });
}
console.log(JSON.stringify(report, null, 2));
