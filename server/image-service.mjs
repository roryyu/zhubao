import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelConfig, configured, endpoint, headers, visionScript, imageProtocol, imageEndpoint } from './model-config.mjs';
import { imageProviderError } from './provider-error.mjs';
import { generateGeometry, geometryReferences, validateGeometry, geometryConfig } from './geometry-service.mjs';
import { exportCadModel, renderPreviews, tolerantJsonObject } from './cad-provider.mjs';
import { buildJewelrySystemPrompt, buildJewelryTextPrompt, buildJewelryImagePrompt, buildAnalysisSystemPrompt, buildAnalysisPrompt, buildCritiquePrompt } from './cad/prompts.mjs';
const execFileAsync = promisify(execFile);

// Each capability uses the configured image model. No CAD, relief, video or
// background-removal service is implied by successful image generation.
const tools = new Map([
  [2000, '根据用户要求设计首饰，呈现清晰的材质、镶嵌与结构细节。'],
  [2001, '精修参考图中的珠宝产品，保留款式和几何结构，改善金属质感、宝石火彩与摄影光线。'],
  [2002, '按用户要求融合所有参考图的指定元素，生成一个连贯的珠宝设计。'],
  [2003, '围绕参考裸石设计珠宝镶嵌，保留裸石外形、颜色与切面；展示可信的金属托架和镶爪。'],
  [2004, '在一张图上展示同一件首饰的正面、侧面、背面三视图，尽量保持结构一致；这是视觉概念图。'],
  [2005, '按指定转换方向处理首饰参考图，保留原始设计结构。'],
  [2006, '按用户描述创作首饰概念图；有参考图片时按描述修改。'],
  [2007, '把参考图中的平面首饰设计转换为具有明确体积、透视、金属反射、宝石切面和可信镶嵌结构的三维渲染效果图，保留原图主体与设计特征。这是立体效果图片，不是网格模型。'],
  [2016, '按指定场景制作首饰展示或佩戴效果图，保留参考首饰的款式和材质。'],
  [2021, '按用户要求完成首饰灵感设计，关注材质、镶嵌结构与整体造型。'],
]);
const needsReference = new Set([2001, 2002, 2003, 2004, 2005, 2007]);
const geometryTools = new Set([2020,2022,2011]);
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function helperSize(params) {
  if (process.env.IMAGE_SIZE) return process.env.IMAGE_SIZE;
  const area = /^1k$/i.test(params.imageSize || '') ? 1024 ** 2 : 2048 ** 2;
  const ratio = /^(\d+):(\d+)$/.exec(params.aspectRatio || '');
  const factor = ratio ? Number(ratio[1]) / Number(ratio[2]) : 1;
  if (factor < 1/8 || factor > 8) throw new Error('图片比例超出当前模型支持范围');
  return `${Math.floor(Math.sqrt(area * factor) / 16) * 16}x${Math.floor(Math.sqrt(area / factor) / 16) * 16}`;
}

export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return '.webp';
  throw new Error('模型未返回有效的 PNG、JPEG 或 WEBP 图片');
}

export function createDesignService(root) {
  const dir = resolve(root, 'data'), generated = resolve(dir, 'generated');
  const tasks = new Map();
  let saving = Promise.resolve();
  const ready = (async () => {
    await mkdir(generated, { recursive: true });
    try {
      for (const task of JSON.parse(await readFile(resolve(dir, 'tasks.json'), 'utf8'))) {
        if (![2,4,6,7,8].includes(task.status)) Object.assign(task, { status: 7, errorMsg: '服务重启，先前生成已中断，请重新提交' });
        tasks.set(task.id, task);
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  })();
  function save() {
    saving = saving.catch(() => {}).then(async () => {
      const file = resolve(dir, 'tasks.json');
      await writeFile(file + '.tmp', JSON.stringify([...tasks.values()], null, 2));
      await rename(file + '.tmp', file);
    });
    return saving;
  }
  async function reference(url, origin) {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin || !/^\/(uploads|generated|media)\//.test(parsed.pathname)) throw new Error('参考图必须先上传或保存到本地');
    const base = parsed.pathname.startsWith('/media/') ? resolve(root, 'dist') : dir;
    const path = resolve(base, '.' + decodeURIComponent(parsed.pathname));
    if (relative(base, path).startsWith('..') || !mime[extname(path).toLowerCase()]) throw new Error('参考图格式不支持');
    const bytes = await readFile(path);
    if (bytes.length > 29 * 1024 * 1024) throw new Error('参考图不能超过 29 MiB');
    imageType(bytes);
    return { bytes, path, type: mime[extname(path).toLowerCase()] };
  }
  function decorate(task, origin) {
    const copy = JSON.parse(JSON.stringify(task));
    const localize = value => {
      if (typeof value==='string' && /^\/(generated|uploads)\//.test(value)) return new URL(value,origin).href;
      if (Array.isArray(value)) return value.map(localize);
      if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,localize(v)]));
      return value;
    };
    copy.output=localize(copy.output); copy.artifacts=localize(copy.artifacts);
    return copy;
  }
  async function run(task, refs, config, prompt) {
    try {
      task.status = 5; await save();
      if(geometryTools.has(task.appNumber)) {
        const result=await generateGeometry({root,task,references:refs,onProgress:async progress=>{task.progress=typeof progress==='string'?progress:progress.message||'正在建模';await save();}});
        Object.assign(task,result,{status:8,finishTime:new Date().toISOString(),progress:'已完成'});
        await save();return;
      }
      if (config.helper) {
        const output = resolve(generated, task.id + '.png');
        const args = [visionScript, '--generate', prompt, '--out', output];
        for (const ref of refs) args.push('--reference', ref.path);
        args.push('--size', helperSize(task.params));
        try {
          await execFileAsync(process.execPath, args, { cwd: root, timeout: config.timeout, maxBuffer: 1024 * 1024 });
        } catch (e) {
          const message = String(e.stderr || '') + String(e.stdout || '');
          if (/(?:API|HTTP)\s*[: ]?\s*429\b|insufficient_quota|quota.*exceed|额度/i.test(message)) throw new Error('模型服务额度不足或限流（HTTP 429），请检查 vision.js 的服务商账户；未生成新设计图。');
          if (/(?:API|HTTP)\s*[: ]?\s*(401|403)\b|invalid.api.key|access.denied/i.test(message)) throw new Error('模型服务鉴权失败，请检查 vision.js 的服务商 Key 与模型权限；未生成新设计图。');
          if (/(?:API|HTTP)\s*[: ]?\s*400\b/i.test(message)) throw new Error('模型服务不接受当前图片参数（HTTP 400），请检查参考图协议、图片大小和分辨率。');
          throw new Error(e.killed ? '图片生成超时，未取得新设计图。' : '图片服务调用失败，请检查 vision.js 的服务商响应与网络；未生成新设计图。');
        }
        const bytes = await readFile(output), extension = imageType(bytes);
        if (extension !== '.png') await rename(output, resolve(generated, task.id + extension));
        Object.assign(task, { status: 8, output: '/generated/' + task.id + extension, finishTime: new Date().toISOString() });
        await save(); return;
      }
      const signal = AbortSignal.timeout(config.timeout);
      const protocol = imageProtocol(config);
      let body, route, requestHeaders = headers(config);
      if (protocol === 'dashscope') {
        route = ''; requestHeaders['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: config.model, input: { messages: [{ role: 'user', content: [
          ...refs.map(r => ({ image: `data:${r.type};base64,${r.bytes.toString('base64')}` })),
          { text: prompt },
        ] }] }, parameters: { n: 1, watermark: false } });
      } else if (protocol === 'chat') {
        route = 'chat/completions'; requestHeaders['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: config.model, stream: false, messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          ...refs.map(r => ({ type: 'image_url', image_url: { url: `data:${r.type};base64,${r.bytes.toString('base64')}` } })),
        ] }] });
      } else if (refs.length) {
        route = 'images/edits'; body = new FormData();
        body.set('model', config.model); body.set('prompt', prompt); body.set('n', '1');
        for (const [i, ref] of refs.entries()) body.append(refs.length === 1 ? 'image' : 'image[]', new Blob([ref.bytes], { type: ref.type }), `reference-${i}.` + ref.type.split('/')[1]);
      } else {
        route = 'images/generations'; requestHeaders['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: config.model, prompt, n: 1 });
      }
      // Provider-specific pixel-size parameters are opt-in. Never claim a
      // requested 4K size was delivered without inspecting the returned file.
      const size = process.env.IMAGE_SIZE;
      if (size) {
        if (body instanceof FormData) body.set('size', size);
        else {
          const value = JSON.parse(body);
          if (protocol === 'dashscope') value.parameters = { ...value.parameters, size: size.replace(/[x×]/i, '*') };
          else if (protocol === 'chat') value.parameters = { size };
          else value.size = size;
          body = JSON.stringify(value);
        }
      }
      const response = await fetch(imageEndpoint(config, route), { method: 'POST', headers: requestHeaders, body, signal });
      if (!response.ok) {
        throw await imageProviderError(response, config);
      }
      const result = await response.json();
      const data = result.data?.[0];
      const content = (result.choices || result.output?.choices)?.[0]?.message?.content;
      const link = data?.url || (Array.isArray(content) ? content.find(x => x.image || x.image_url)?.image || content.find(x => x.image_url)?.image_url?.url : null);
      let bytes;
      if (data?.b64_json) bytes = Buffer.from(data.b64_json, 'base64');
      else if (typeof link === 'string' && link.startsWith('data:image/')) bytes = Buffer.from(link.split(',')[1] || '', 'base64');
      else if (typeof link === 'string' && /^https?:\/\//.test(link)) {
        const downloaded = await fetch(link, { signal });
        if (!downloaded.ok) throw new Error('模型图片下载失败');
        bytes = Buffer.from(await downloaded.arrayBuffer());
      } else throw new Error('模型响应中没有图片，未将文字或预存图片当作生成结果');
      if (bytes.length > 50 * 1024 * 1024) throw new Error('模型输出图片超过本地 50 MiB 限制');
      const extension = imageType(bytes), file = task.id + extension;
      await writeFile(resolve(generated, file), bytes);
      Object.assign(task, { status: 8, output: '/generated/' + file, finishTime: new Date().toISOString() });
    } catch (e) {
      // Never include raw provider responses, tokens or signed download URLs.
      task.status = 6;
      task.errorMsg = e.name === 'TimeoutError' ? '生成超时，请在服务商控制台核对调用状态后重试' : /^(模型|图片|浮雕|建模|CAD|3D|缺少|深度|输入)/.test(e.message) ? e.message : '生成失败，请检查模型配置、参数或网络';
    }
    await save();
  }
  // ---- Agent 往返管线：提示词交给客户端大模型，结果回传本地构建/导出/保存 ----
  // 会话保存在内存（与对话一致）；任务写入同一 tasks 历史，网页端可见。
  const agentSessions = new Map();
  const AGENT_TTL = 30 * 60 * 1000;
  const localUrl = path => {
    const rel = relative(dir, path);
    if (rel.startsWith('..')) throw new Error('文件不在本地数据目录内');
    return '/' + rel.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  };
  function sweepAgentSessions() {
    const now = Date.now();
    for (const [id, session] of agentSessions) {
      if (now - session.lastActivity > AGENT_TTL) {
        const task = tasks.get(id);
        if (task && ![2,4,6,7,8].includes(task.status)) Object.assign(task, { status: 7, errorMsg: 'Agent 会话超时，请重新提交', finishTime: new Date().toISOString() });
        agentSessions.delete(id);
      }
    }
  }
  const agentBusy = () => [...tasks.values()].some(t => ![2,4,6,7,8].includes(t.status));
  async function buildPrompt(number, params, description) {
    let instruction = tools.get(number) || '真实几何建模';
    if (number === 2005) instruction += String(params.presetId) === '1' ? '把写实图转换为清晰的珠宝设计线稿。' : '把设计线稿转换为写实的珠宝产品图。';
    if (number === 2016 && params.presetId) {
      const data = JSON.parse(await readFile(resolve(root, 'server/public-data.json'), 'utf8'));
      const presets = data.options[2016]?.list.find(p => p.paramsName === 'prompt_head');
      try { instruction += JSON.parse(presets?.value || '{}')[params.presetId] || `场景：${params.presetId}。`; } catch {}
    }
    return `${instruction}\n用户需求：${description}\n画幅比例：${params.aspectRatio || '自动'}。请求清晰度：${params.imageSize || '模型默认'}。实际像素尺寸以模型输出为准。不要添加水印或无关文字。`;
  }
  function agent3dPrompt(session, origin) {
    const referenceImages = session.refs.map(r => new URL(localUrl(r.path), origin).href);
    if (session.stage === 'analysis') return { stage: 'analysis', system_prompt: buildAnalysisSystemPrompt(), user_prompt: buildAnalysisPrompt(session.text), reference_images: referenceImages };
    if (session.stage === 'build') return { stage: 'build', system_prompt: buildJewelrySystemPrompt(), user_prompt: session.refs.length ? buildJewelryImagePrompt(session.text, session.plan) : buildJewelryTextPrompt(session.text), reference_images: referenceImages };
    return { stage: 'critique', system_prompt: buildJewelrySystemPrompt(), user_prompt: buildCritiquePrompt(session.text, session.plan, { hasReference: session.refs.length > 0, round: session.round }), reference_images: referenceImages, render_images: session.renderImages };
  }
  async function agentImagePrepare({ body, origin }) {
    sweepAgentSessions();
    const number = Number(body?.appNumber || 2006);
    if (!tools.has(number)) return { code: 40001, msg: '不支持的图片工具编号', data: null };
    if (agentBusy()) return { code: 40901, msg: '已有任务正在生成，请等待完成后再提交。', data: null };
    const description = String(body?.prompt || '').trim();
    const urls = body?.images || [];
    if (!description) return { code: 40001, msg: '请输入设计需求', data: null };
    if (description.length > 12000) return { code: 40001, msg: '设计描述过长，请控制在 12000 字以内', data: null };
    if (!Array.isArray(urls) || urls.length > 4 || urls.some(u => typeof u !== 'string')) return { code: 40001, msg: '最多使用 4 张本地参考图', data: null };
    if (needsReference.has(number) && urls.length < (number === 2002 ? 2 : 1)) return { code: 40001, msg: '此设计工具需要上传参考图片', data: null };
    try { await Promise.all(urls.map(u => reference(u, origin))); }
    catch (e) { return { code: 40001, msg: e.message, data: null }; }
    const params = { prompt: description, image: urls, aspectRatio: body?.aspectRatio, imageSize: body?.imageSize };
    const id = randomUUID();
    const task = { id, taskId: id, appNumber: number, drawAppNumber: number, status: 5, output: null, prompt: description, originalPromptJson: JSON.stringify(params), createDate: new Date().toISOString(), nickName: 'Agent 设计', providerModel: 'agent-client-model', params, progress: '等待客户端模型出图' };
    tasks.set(id, task); await save();
    agentSessions.set(id, { kind: 'image', lastActivity: Date.now() });
    const prompt = await buildPrompt(number, params, description);
    return { code: 0, msg: 'success', data: { task_id: id, prompt, reference_images: urls, next_step: '请由客户端模型按 prompt 生成图片（可参考 reference_images），再调用 image/submit 回传图片' } };
  }
  async function agentImageSubmit({ body, origin }) {
    const session = agentSessions.get(body?.task_id);
    const task = tasks.get(body?.task_id);
    if (!session || session.kind !== 'image' || !task) return { code: 40401, msg: 'Agent 会话不存在或已过期，请重新 prepare', data: null };
    session.lastActivity = Date.now();
    try {
      const image = body?.image;
      let bytes;
      if (typeof image === 'string' && image.startsWith('data:image/')) bytes = Buffer.from(image.split(',')[1] || '', 'base64');
      else if (typeof image === 'string') bytes = (await reference(image, origin)).bytes;
      else throw new Error('image 须为 data URL 或本地 /uploads|/generated 图片地址');
      if (bytes.length > 50 * 1024 * 1024) throw new Error('图片超过本地 50 MiB 限制');
      const extension = imageType(bytes);
      await writeFile(resolve(generated, task.id + extension), bytes);
      Object.assign(task, { status: 8, output: '/generated/' + task.id + extension, finishTime: new Date().toISOString(), progress: '已完成' });
      agentSessions.delete(task.id);
      await save();
      return { code: 0, msg: 'success', data: { status: 'succeeded', task_id: task.id, output: new URL(task.output, origin).href, view_url: `${origin}/workspace/${task.appNumber}` } };
    } catch (e) {
      return { code: 40001, msg: e.message, data: null };
    }
  }
  async function agent3dPrepare({ body, origin }) {
    sweepAgentSessions();
    if (agentBusy()) return { code: 40901, msg: '已有任务正在生成，请等待完成后再提交。', data: null };
    const mode = body?.mode || (body?.imageUrl ? 'image' : 'text');
    if (!['text', 'image'].includes(mode)) return { code: 40001, msg: '3D 输入模式无效', data: null };
    const text = String(body?.prompt || '').trim();
    if (text.length > 12000) return { code: 40001, msg: '建模描述过长，请控制在 12000 字以内', data: null };
    if (mode === 'text' && !text) return { code: 40001, msg: '请输入首饰建模需求和必要尺寸', data: null };
    let refs = [];
    if (mode === 'image') {
      if (!body?.imageUrl) return { code: 40001, msg: '请先上传建模参考图片', data: null };
      try { refs = [await reference(body.imageUrl, origin)]; }
      catch (e) { return { code: 40001, msg: e.message, data: null }; }
    }
    const refineRounds = Math.min(2, Math.max(0, Number(body?.refineRounds ?? 1) || 0));
    const params = { mode, prompt: text, imageUrl: body?.imageUrl };
    const id = randomUUID();
    const task = { id, taskId: id, appNumber: 2011, drawAppNumber: 2011, status: 5, output: null, prompt: text, originalPromptJson: JSON.stringify(params), createDate: new Date().toISOString(), nickName: 'Agent 建模', providerModel: 'agent-client-model', params, progress: '等待客户端模型输出建模 JSON' };
    tasks.set(id, task); await save();
    const outputDir = resolve(generated, id);
    await mkdir(outputDir, { recursive: true });
    const session = { kind: '3d', stage: mode === 'image' && body?.analyze !== false ? 'analysis' : 'build', plan: null, text, refs, refineRounds, round: 0, attempts: 0, refineApplied: 0, appearance: body?.appearance === 'Geometry' ? 'Geometry' : 'Normal', outputDir, result: null, renderImages: [], lastActivity: Date.now() };
    agentSessions.set(id, session);
    return { code: 0, msg: 'success', data: { task_id: id, ...agent3dPrompt(session, origin), next_step: '请由客户端模型按 system_prompt/user_prompt 输出 JSON（可参考 reference_images），再调用 3d/submit 回传 output' } };
  }
  async function afterBuild(session, task, origin, finish) {
    if (session.round >= session.refineRounds) return finish(session.result, { refineApplied: session.refineApplied || 0 });
    session.round += 1;
    task.progress = `正在渲染三视角预览（第 ${session.round} 轮自评）`; await save();
    const views = await renderPreviews(session.result.artifacts.STL, session.outputDir, task.id, session.round);
    if (!views) return finish(session.result, { refineApplied: session.refineApplied || 0, refineNote: '预览渲染不可用（需 setup:geometry），已跳过自评修正' });
    session.renderImages = views.map(v => new URL(localUrl(v.path), origin).href);
    session.stage = 'critique';
    return { code: 0, msg: 'success', data: { task_id: task.id, ...agent3dPrompt(session, origin), next_step: '请由客户端模型对比参考图与渲染图，输出评审结论 JSON（verdict=ok 或 revise+完整修正模型），再调用 3d/submit' } };
  }
  async function agent3dSubmit({ body, origin }) {
    const session = agentSessions.get(body?.task_id);
    const task = tasks.get(body?.task_id);
    if (!session || session.kind !== '3d' || !task) return { code: 40401, msg: 'Agent 会话不存在或已过期，请重新 prepare', data: null };
    session.lastActivity = Date.now();
    const raw = body?.output;
    if (raw === undefined || raw === null || (typeof raw !== 'string' && typeof raw !== 'object')) return { code: 40001, msg: 'output 须为客户端模型返回的 JSON（对象或字符串）', data: null };
    const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const finish = async (result, extra = {}) => {
      const artifacts = Object.fromEntries(Object.entries(result.artifacts).map(([format, path]) => [format, new URL(localUrl(path), origin).href]));
      Object.assign(task, { status: 8, output: new URL(localUrl(result.modelPath), origin).href, artifacts, metadata: { ...result.metadata, ...extra }, finishTime: new Date().toISOString(), progress: '已完成' });
      agentSessions.delete(task.id);
      await save();
      return { code: 0, msg: 'success', data: { status: 'succeeded', task_id: task.id, output: task.output, artifacts, metadata: task.metadata, view_url: `${origin}/workspace/2011` } };
    };
    const fail = async message => {
      Object.assign(task, { status: 6, errorMsg: message, finishTime: new Date().toISOString() });
      agentSessions.delete(task.id);
      await save();
      return { code: 0, msg: 'success', data: { status: 'failed', task_id: task.id, error: message } };
    };
    try {
      if (session.stage === 'analysis') {
        await writeFile(resolve(session.outputDir, task.id + '-analysis.json'), rawText);
        const parsed = tolerantJsonObject(rawText);
        const planObject = Array.isArray(parsed) ? parsed.find(item => item && typeof item === 'object') : parsed;
        if (planObject && Array.isArray(planObject.parts)) session.plan = planObject;
        session.stage = 'build';
        return { code: 0, msg: 'success', data: { task_id: task.id, ...agent3dPrompt(session, origin), next_step: '分析已接收，请继续由客户端模型输出 CadModel JSON，再调用 3d/submit' } };
      }
      if (session.stage === 'build') {
        await writeFile(resolve(session.outputDir, task.id + `-draft-${session.attempts + 1}.json`), rawText);
        try {
          session.result = await exportCadModel({ raw: rawText, outputDir: session.outputDir, taskId: task.id, providerModel: 'agent-client-model', appearance: session.appearance });
        } catch (error) {
          session.attempts += 1;
          if (session.attempts > 2) return fail('建模校验失败：' + error.message.slice(0, 500));
          return { code: 0, msg: 'success', data: { task_id: task.id, stage: 'build', correction: true, system_prompt: buildJewelrySystemPrompt(), user_prompt: '建模校验失败，请保持设计意图并修正以下问题，只输出完整 CadModel JSON，不得执行代码或省略结构。\n' + error.message.slice(0, 5000), reference_images: agent3dPrompt(session, origin).reference_images, next_step: '请在同一对话中让客户端模型修正并输出完整 CadModel JSON，再调用 3d/submit' } };
        }
        return await afterBuild(session, task, origin, finish);
      }
      // critique 阶段：解析评审结论，ok 完成 / revise 重建 / 无效保留当前模型
      await writeFile(resolve(session.outputDir, task.id + `-critique-${session.round}.json`), rawText);
      const parsed = tolerantJsonObject(rawText);
      let verdict = null, salvageModel = null;
      if (Array.isArray(parsed)) {
        const nodes = parsed.filter(v => v && typeof v === 'object' && typeof v.kind === 'string');
        if (nodes.length) salvageModel = { units: 'mm', model: nodes.length === 1 ? nodes[0] : { kind: 'union', children: nodes } };
      } else if (parsed && typeof parsed === 'object') {
        if (parsed.verdict) verdict = parsed;
        else if (parsed.model || typeof parsed.kind === 'string') salvageModel = parsed.model ? parsed : { units: 'mm', model: parsed };
      }
      if (salvageModel) {
        let note = '';
        try {
          session.result = await exportCadModel({ raw: salvageModel, outputDir: session.outputDir, taskId: task.id, providerModel: 'agent-client-model', appearance: session.appearance });
          session.refineApplied = session.round;
        } catch (error) { note = '自评修正未通过结构校验，已保留修正前模型：' + error.message.slice(0, 300); }
        return finish(session.result, { refineApplied: session.refineApplied || 0, refineNote: note || undefined });
      }
      if (!verdict) return finish(session.result, { refineNote: '自评未返回有效结论，已保留当前模型' });
      if (verdict.verdict === 'ok') return finish(session.result, { refineApplied: session.refineApplied || 0 });
      if (verdict.verdict !== 'revise' || !verdict.model) return finish(session.result, { refineNote: '自评结论无法解析，已保留当前模型' });
      const candidate = verdict.model.model ? verdict.model : { units: 'mm', title: session.result.metadata.title, model: verdict.model };
      try {
        session.result = await exportCadModel({ raw: candidate, outputDir: session.outputDir, taskId: task.id, providerModel: 'agent-client-model', appearance: session.appearance });
        session.refineApplied = session.round;
        if (Array.isArray(verdict.issues)) session.result.metadata.refineIssues = verdict.issues.slice(0, 8);
      } catch (error) {
        return finish(session.result, { refineNote: '自评修正未通过结构校验，已保留修正前模型：' + error.message.slice(0, 300) });
      }
      return await afterBuild(session, task, origin, finish);
    } catch (e) {
      return fail('建模处理失败：' + e.message.slice(0, 500));
    }
  }
  return {
    ready,
    async handle({ pathname, query, method, body, origin }) {
      await ready;
      const ok = data => ({ code: 0, msg: 'success', data });
      if (pathname === '/api/unified/submit-task' && method === 'POST') {
        const number = Number(body?.appNumber), params = body?.params;
        const geometric=geometryTools.has(number);
        if (!tools.has(number) && !geometric) return { code: 50101, msg: '该工具需要独立的视频或图像处理服务，目前尚未接入。', data: null };
        const config = modelConfig('image');
        if (!geometric && !configured(config)) return { code: 50101, msg: '请先在项目 .env 配置 IMAGE_BASE_URL、IMAGE_API_KEY 和 IMAGE_MODEL，再重启服务。', data: null };
        if (!geometric && !config.helper && !['images', 'chat', 'dashscope'].includes(imageProtocol(config))) return { code: 40001, msg: 'IMAGE_API_STYLE 必须为 auto、images、chat 或 dashscope', data: null };
        if ([...tasks.values()].some(t => ![2,4,6,7,8].includes(t.status))) return { code: 40901, msg: '已有设计正在生成，请等待完成后再提交。', data: null };
        if (!params || typeof params !== 'object') return { code: 40001, msg: '缺少设计参数', data: null };
        const geometryError=geometric?validateGeometry(number,params):'';
        if(geometryError)return {code:40001,msg:geometryError,data:null};
        if (config.helper && /^4k$/i.test(params.imageSize || '')) return { code: 40001, msg: '当前 vision.js 图片模型最高支持约 2K 等效像素，请选择 1K 或 2K；尚未接入 4K 超分服务。', data: null };
        const description = String(params.additionalPrompt || params.prompt || '').trim();
        const urls = geometric ? geometryReferences(number,params) : params.image || params.imageUrls || [];
        if (!Array.isArray(urls) || urls.length > 4 || urls.some(u => typeof u !== 'string')) return { code: 40001, msg: '最多使用 4 张本地参考图', data: null };
        if (needsReference.has(number) && urls.length < (number === 2002 ? 2 : 1)) return { code: 40001, msg: '此设计工具需要上传参考图片', data: null };
        if(geometric && !(number===2011 && params.mode==='text') && !urls.length)return {code:40001,msg:'请先上传建模参考图片',data:null};
        if (!description && !urls.length) return { code: 40001, msg: '请输入首饰设计需求或上传参考图', data: null };
        if (description.length > 12000) return { code: 40001, msg: '设计描述过长，请控制在 12000 字以内', data: null };
        let refs;
        try { refs = await Promise.all(urls.map(u => reference(u, origin))); if (!geometric && !config.helper) endpoint(config, ''); }
        catch (e) { return { code: 40001, msg: e.message, data: null }; }
        const prompt = await buildPrompt(number, params, description);
        const id = randomUUID(), task = { id, taskId: id, appNumber: number, drawAppNumber: number, status: 0, output: null, prompt: description, originalPromptJson: JSON.stringify(params), createDate: new Date().toISOString(), nickName: '本地设计', providerModel: geometric ? (number===2011?geometryConfig().model:'Depth Anything V2 Small') : config.helper ? (process.env.IMAGE_MODEL || 'vision.js 默认图片模型') : config.model, params };
        tasks.set(id, task); await save();
        void run(task, refs, config, prompt);
        return ok({ task_id: id });
      }
      const match = pathname.match(/^\/api\/draw\/comfyuiTask\/([^/]+)$/);
      if (match && match[1] !== 'page' && method === 'GET') return tasks.has(match[1]) ? ok(decorate(tasks.get(match[1]), origin)) : { code: 40401, msg: '未找到本地任务', data: null };
      if (['/api/draw/comfyuiTask/page','/api/draw/getListNew'].includes(pathname) && method === 'GET') {
        const number = Number(query.get('drawAppNumber') || query.get('appNumber') || 0);
        const rows = [...tasks.values()].filter(t => !number || t.appNumber === number).reverse();
        const page = Math.max(1, Number(query.get('page') || 1)), limit = Math.max(1, Math.min(100, Number(query.get('limit') || 10)));
        return ok({ list: rows.slice((page-1)*limit, page*limit).map(t => decorate(t, origin)), total: rows.length, page, limit });
      }
      if (pathname === '/api/draw/comfyuiTask' && method === 'DELETE') {
        const ids = Array.isArray(body) ? body : body?.ids || [body?.id];
        if (ids.some(id => tasks.has(id) && ![2,4,6,7,8].includes(tasks.get(id).status))) return { code: 40901, msg: '生成中的任务不能删除', data: null };
        for (const id of ids) tasks.delete(id);
        await save(); return ok(null);
      }
      if (pathname === '/api/agent/image/prepare' && method === 'POST') return agentImagePrepare({ body, origin });
      if (pathname === '/api/agent/image/submit' && method === 'POST') return agentImageSubmit({ body, origin });
      if (pathname === '/api/agent/3d/prepare' && method === 'POST') return agent3dPrepare({ body, origin });
      if (pathname === '/api/agent/3d/submit' && method === 'POST') return agent3dSubmit({ body, origin });
      return null;
    },
  };
}
