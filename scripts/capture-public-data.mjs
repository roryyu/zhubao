import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(await readFile('/tmp/cjzb-public-api-probe.json', 'utf8'));
const sources = [], failures = [];
async function get(path) {
  const known = seed.find(r => r.path === path);
  const response = known ? known.response : await (await fetch('https://cjzbai.com/v1' + path, { signal: AbortSignal.timeout(20000) })).json();
  sources.push({ path, code: response.code, authentication: 'none; no cookies or token supplied' });
  if (response.code !== 0) { failures.push({ path, code: response.code }); return null; }
  return response.data;
}
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object[k] !== undefined).map(k => [k, object[k]]));
const categories = (await get('/api/drawApp/categoryList?isAll=0')).map(c => pick(c, ['id', 'categoryName', 'status', 'sort']));
const apps = [];
for (const category of categories) {
  const data = await get(`/api/drawApp/page?page=1&limit=50&classId=${category.id}&isShow=1&order=asc&orderField=sort&drawClientCapabilities=relief-v3`);
  for (const app of data?.list || []) apps.push({ ...pick(app, ['id', 'number', 'type', 'name', 'description', 'exampleImg', 'sort', 'isShow', 'price', 'billingMode', 'className', 'isCanDrawSame', 'isPower', 'icon', 'freeIsCanUse', 'isOpenWatermark', 'watermarkPrice', 'defaultParams', 'params']), classId: category.id });
}
const options = {};
for (let i = 0; i < apps.length; i += 3) {
  await Promise.all(apps.slice(i, i + 3).map(async app => {
    const data = await get(`/api/draw/drawAppParamsOptions/page?page=1&limit=100&drawAppNumber=${app.number}`);
    options[app.number] = { total: data?.total || 0, list: (data?.list || []).map(row => pick(row, ['id', 'drawAppNumber', 'drawAppName', 'paramsName', 'name', 'valueType', 'value', 'sort', 'className', 'otherData', 'type'])) };
  }));
}
const shopKeys = ['id', 'name', 'number', 'price', 'originalPrice', 'send', 'sort', 'howMuchTime', 'remarks'];
const goldShop = (await get('/api/config/goldShopList')).map(x => pick(x, shopKeys));
const vipShop = (await get('/api/config/vipShopList')).map(x => pick(x, shopKeys));
const data = { capturedAt: new Date().toISOString(), provenance: 'Read-only public API, no authentication. Only UI fields retained. No production account or generation history.', categories, apps, options, goldShop, vipShop, sources, failures };
await writeFile(resolve(root, 'server/public-data.json'), JSON.stringify(data, null, 2));
await writeFile(resolve(root, 'evidence/public-api-sources.json'), JSON.stringify({ capturedAt: data.capturedAt, sources, failures }, null, 2));
console.log(JSON.stringify({ categories: categories.length, apps: apps.length, options: Object.values(options).reduce((n, x) => n + x.list.length, 0), failures }));
