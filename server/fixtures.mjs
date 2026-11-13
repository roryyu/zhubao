// Shapes follow the deployed application's response consumers. This is local
// demonstration data, not an export of the user's account or the cloud database.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { conversations, answers, createConversation } from './chat-store.mjs';
import { reliefFormats } from './geometry-service.mjs';
const publicData = JSON.parse(readFileSync(new URL('./public-data.json', import.meta.url), 'utf8'));
const sourceFailures = JSON.parse(readFileSync(new URL('../evidence/public-content-manifest.json', import.meta.url), 'utf8')).failures;
export const localUser = { id: '100001', nickName: '本地演示', msgCount: 50, avatar: '/local/avatar.svg', phone: '', vipLevel: 0, isVip: 0, money: 0, inviteCode: 'LOCAL-DEMO', createTime: '2026-11-08 00:00:00', createDate: '2026-11-08 00:00:00', userCreateTime: '2026-11-08 00:00:00' };
export const categories = publicData.categories;
export const apps = publicData.apps;
const favourites = new Map();
const ok = data => ({ code: 0, msg: 'success', data });
const page = (list = []) => ({ list, total: list.length, page: 1, pages: list.length ? 1 : 0, limit: 100, records: list });
export const unavailable = () => ({ code: 50101, msg: '本地预览未接入云端 AI、支付或短信服务。未提交线上任务，不会扣费。', data: null });

function options(query) {
  const number = Number(query.get('drawAppNumber'));
  const name = query.get('paramsName') || '';
  const observed = publicData.options[number];
  if (observed) return page(observed.list.filter(r => !name || r.paramsName === name));
  return page();
}

export async function handleLocalApi({ pathname, query, method, body, origin = 'http://127.0.0.1:4174' }) {
  const contentPath = new URL('./public-content.json', import.meta.url);
  let contentText = existsSync(contentPath) ? readFileSync(contentPath, 'utf8').replaceAll('@@ORIGIN@@', origin) : '{"models":[],"tutorials":[],"gallery":[]}';
  for (const failure of sourceFailures) if (failure.source) contentText = contentText.replaceAll(failure.source, /\.(png|jpe?g|webp)(\?|$)/i.test(failure.source) ? origin + '/local/image-not-found.svg' : origin + '/__local/unavailable/' + new URL(failure.source).pathname.split('/').pop());
  const content = JSON.parse(contentText);
  const paginate = rows => {
    const n = Math.max(1, Number(query.get('page') || 1)), limit = Math.max(1, Math.min(100, Number(query.get('limit') || 20)));
    return { ...page(rows.slice((n - 1) * limit, n * limit)), total: rows.length, page: n, limit };
  };
  if (pathname === '/api/user/userInfo') return ok({ ...localUser, avatar: new URL('/local/avatar.svg', origin).href });
  if (pathname === '/api/config/baseConfig') return ok(JSON.parse(JSON.stringify(publicData.baseConfig || []).replaceAll('@@ORIGIN@@', origin)).map(item => item.paramCode === 'draw_record_keep_day' ? { ...item, paramValue: '0' } : item));
  if (pathname === '/api/config/notice/list') return ok([]);
  if (pathname === '/api/drawApp/categoryList') return ok(categories);
  if (pathname === '/api/drawApp/page') {
    const id = query.get('classId');
    return ok(page(id && id !== '0' ? apps.filter(a => String(a.classId) === id) : apps));
  }
  const appMatch = pathname.match(/^\/api\/drawApp\/number\/(\d+)$/);
  if (appMatch) return ok(apps.find(a => a.number === Number(appMatch[1])) || { number: Number(appMatch[1]), name: '本地工具', isShow: 1, price: 0, billingMode: 1 });
  if (pathname === '/api/draw/drawAppParamsOptions/page') return ok(options(query));
  if (pathname === '/api/relief-pro/config') {
    const number = Number(query.get('appNumber') || 2020);
    const featureId = number === 2022 ? 'lineart' : number === 2023 ? 'vectorline' : 'relief';
    const formats = reliefFormats[number] || (featureId === 'vectorline' ? ['DXF', 'AI'] : ['TIF','EXR','PNG','STL','GLB']);
    return ok({ featureId, modes: ['浅浮雕', '中浮雕', '高浮雕'], formats, platformCost: apps.find(a => a.number === number)?.price || 45, defaults: { mode: '中浮雕' }, priceRevision: 'local-demo-1', parameters_revision: 'local-demo-1' });
  }
  if (pathname === '/api/draw/getPublicList') {
    const search = (query.get('searchKey') || '').toLowerCase(), type = query.get('reqType');
    let rows = content.gallery.filter(x => (!type || String(x.reqType) === type) && (!search || `${x.prompt || ''} ${x.nickName || ''} ${x.reqTypeName || ''}`.toLowerCase().includes(search))).map(x => ({ ...x, isStar: favourites.get(String(x.id)) ?? x.isStar }));
    if (query.get('order') === 'asc') rows = [...rows].reverse();
    return ok(paginate(rows));
  }
  if (pathname === '/api/draw/getListNew' || pathname === '/api/draw/comfyuiTask/page') return ok(page());
  if (pathname === '/api/draw/starImg' && method === 'POST') { favourites.set(String(body?.id), Number(body?.isStar || 0)); return ok(null); }
  const publicTask = pathname.match(/^\/api\/draw\/getPublicTaskInfo\/([^/]+)$/);
  if (publicTask) {
    const taskFile = new URL('./public-tasks.json', import.meta.url);
    const task = existsSync(taskFile) ? JSON.parse(readFileSync(taskFile, 'utf8').replaceAll('@@ORIGIN@@', origin)).tasks[publicTask[1]] : null;
    return task ? ok(task) : { code: 40402, msg: '该公开作品的共享参数未取得', data: null };
  }
  if (pathname === '/api/questionWindowNew/list') return ok([...conversations.values()]);
  if (pathname === '/api/questionWindowNew/questionList') {
    let rows = [...(answers.get(String(query.get('windowId'))) || [])].reverse().map(({ questionContent, ...item }) => item);
    if (query.get('latestTime')) rows = rows.filter(item => item.createDate < query.get('latestTime'));
    return ok(paginate(rows));
  }
  if (pathname === '/api/questionWindowNew/create' && method === 'POST') {
    createConversation(body?.modeId || null);
    return ok([...conversations.values()]);
  }
  if (pathname === '/api/questionWindowNew/delete' && method === 'POST') {
    const ids = body?.deleteAll ? [...conversations.keys()] : [String(body?.id)];
    for (const id of ids) { conversations.delete(id); answers.delete(id); }
    return ok([...conversations.values()]);
  }
  if (pathname === '/api/questionWindowNew/changeDefault' && method === 'POST') { for (const item of conversations.values()) item.isDefault = item.id === body?.id; return ok([...conversations.values()]); }
  const copiedWindow = pathname.match(/^\/api\/questionWindowNew\/copy\/([^/]+)$/);
  if (copiedWindow && method === 'POST') {
    const source = conversations.get(copiedWindow[1]);
    if (!source) return { code: 40401, msg: '未找到本地对话', data: null };
    const copy = createConversation(source.modeId);
    Object.assign(copy, { title: source.title, windowName: source.windowName, questionCount: source.questionCount || 0 });
    answers.set(copy.id, JSON.parse(JSON.stringify(answers.get(source.id) || [])).map(item => ({ ...item, id: randomUUID() })));
    return ok([...conversations.values()]);
  }
  if (['/api/questionAnswer/update', '/api/questionAnswer/delete'].includes(pathname) && ['PUT', 'DELETE'].includes(method)) {
    for (const [windowId, rows] of answers) {
      const row = rows.find(item => item.id === body?.id);
      if (!row) continue;
      const field = Number(body.type) === 0 ? 'question' : 'answer';
      if (pathname.endsWith('/update')) { row[field] = String(body.msg || ''); if (field === 'question') row.questionContent = row.question; }
      else { row[field] = ''; if (field === 'question') row.questionContent = ''; }
      answers.set(windowId, rows.filter(item => item.question || item.answer));
      if (conversations.has(windowId)) conversations.get(windowId).questionCount = answers.get(windowId).length;
      return ok(null);
    }
    return { code: 40401, msg: '未找到本地消息', data: null };
  }
  if (pathname === '/api/aiModel/page') return ok(page(content.models));
  if (pathname === '/api/team/status') return ok({ hasTeam: false, inTeam: false, isOwner: false, isAdmin: false, team: null, member: null, teamId: null });
  if (pathname === '/api/team/groups') return ok([]);
  if (pathname === '/api/team/members' || pathname === '/api/team/drawTasks' || pathname === '/api/team/billGold' || pathname === '/api/team/works/page' || pathname === '/api/team/works/members' || pathname === '/api/team/quotaOpLogs') return ok(page());
  if (pathname === '/api/team/drawAppList') return ok(apps);
  if (pathname === '/api/team/groupReport') return ok({ list: [], totalGold: 0, totalTasks: 0 });
  if (pathname === '/api/config/goldShopList') return ok(publicData.goldShop);
  if (pathname === '/api/config/vipShopList') return ok(publicData.vipShop);
  if (pathname === '/api/PayConfigList') return ok([]);
  if (pathname === '/api/news/page') return ok(paginate(content.tutorials));
  const newsMatch = pathname.match(/^\/api\/news\/([^/]+)$/);
  if (newsMatch && newsMatch[1] !== 'categoryList') return ok(content.tutorials.find(x => String(x.id) === newsMatch[1]) || null);
  if (pathname === '/api/sonListPage' || pathname.startsWith('/api/billChange') || pathname === '/api/withdrawal/page') return ok(page());
  if (pathname === '/api/news/categoryList') return ok([]);
  if (method !== 'GET' && method !== 'HEAD') return unavailable();
  return { code: 40401, msg: `本地接口尚未配置：${pathname}`, data: null };
}
