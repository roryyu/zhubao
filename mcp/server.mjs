#!/usr/bin/env node
// 无觉珠宝 AI 本地版 · MCP 服务（零依赖，stdio JSON-RPC）
//
// 职责边界：本服务只提供工具和本地算力，不调用任何大模型，也不需要模型密钥。
//   - 从 GitHub 克隆工程 → 下载前端资源包 → 安装构建 → 启动本地服务；
//   - 向调用方 Agent（Codex / Workbuddy / Claude Code 等）返回提示词、参考图 URL；
//     由 Agent 用自己的大模型生成图片或建模 JSON，再回传本服务；
//   - 本服务只做本地几何构建、校验、渲染导出和页面展示。
//   工程自带的网页工作台（/workspace/*）用工程自己的 .env 模型配置，与 MCP 无关；
//   MCP 不读取、不写入、不改造该 .env。
//
// 配置全部走 MCP 客户端的环境变量（见 mcp/README.md）：
//   CJZBAI_PROJECT_DIR  工程目录，默认 ~/.cjzbai-mcp/zhubao（不存在时自动克隆）
//   CJZBAI_REPO_URL     仓库地址，默认 https://github.com/roryyu/zhubao.git
//   CJZBAI_ASSETS_URL   前端资源包地址（GitHub Release 或本地 tar 路径）
//   CJZBAI_PORT         本地服务端口，默认 4174
//
// stdout 只输出 JSON-RPC 协议消息，日志一律走 stderr。

import { existsSync, createWriteStream, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const SERVER_NAME = 'cjzbai-local';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';

const projectDir = resolve(process.env.CJZBAI_PROJECT_DIR || join(homedir(), '.cjzbai-mcp', 'zhubao'));
const stateDir = resolve(process.env.CJZBAI_STATE_DIR || join(homedir(), '.cjzbai-mcp'));
const repoUrl = process.env.CJZBAI_REPO_URL || 'https://github.com/roryyu/zhubao.git';
const assetsUrl = process.env.CJZBAI_ASSETS_URL || 'https://github.com/roryyu/zhubao/releases/download/frontend-assets-v1/frontend-assets.tar';
const port = Number(process.env.CJZBAI_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const pidFile = join(stateDir, `server-${port}.pid`);
const logFile = join(stateDir, `server-${port}.log`);
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const log = (...args) => console.error(`[${SERVER_NAME}]`, ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 进程与命令 ----------

async function run(command, args, options = {}) {
  log(`执行 ${command} ${args.join(' ')}`);
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: projectDir, maxBuffer: 16 * 1024 * 1024, ...options });
    return stdout;
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-8).join('\n');
    throw new Error(`${command} ${args[0] || ''} 失败：${tail}`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch { return null; }
}

// ---------- 本地服务 HTTP ----------

async function health() {
  try {
    const res = await fetch(`${baseUrl}/__local/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch { return null; }
}

async function waitHealth(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const info = await health();
    if (info) return info;
    await sleep(500);
  }
  return null;
}

async function api(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Origin: baseUrl, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`本地服务返回异常（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok && data.code === undefined) throw new Error(data.msg || `本地服务 HTTP ${res.status}`);
  return data;
}

// ---------- 自举安装 ----------

async function downloadAssets() {
  mkdirSync(stateDir, { recursive: true });
  let tarPath;
  if (!/^https?:\/\//.test(assetsUrl) && existsSync(assetsUrl)) {
    tarPath = resolve(assetsUrl); // 支持本地 tar 包，便于离线安装
  } else {
    tarPath = join(stateDir, 'frontend-assets.tar');
    log(`下载前端资源包 ${assetsUrl}（约 1.3 GB，只需一次）`);
    const res = await fetch(assetsUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok) throw new Error(`前端资源包下载失败（HTTP ${res.status}）：${assetsUrl}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath + '.partial'));
    const { rename } = await import('node:fs/promises');
    await rename(tarPath + '.partial', tarPath);
  }
  progress('正在解压前端资源');
  await run('tar', ['-xf', tarPath, '-C', projectDir], { cwd: projectDir });
  if (!existsSync(join(projectDir, 'captured', 'index.html'))) throw new Error('前端资源包内容不完整：缺少 captured/index.html');
}

async function startServer() {
  mkdirSync(stateDir, { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  log(`本地服务已启动 pid=${child.pid}，日志 ${logFile}`);
}

async function stopOwnedServer() {
  const pid = readPid();
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
  return true;
}

let ensuring = null;
function ensureReady(options = {}) {
  if (!ensuring) ensuring = doEnsureReady(options).finally(() => { ensuring = null; });
  return ensuring;
}

async function doEnsureReady({ relief = false } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`需要 Node.js 24 或更新版本，当前 ${process.versions.node}；请在 MCP 配置中指定 node 绝对路径`);

  if (!existsSync(join(projectDir, 'server.mjs'))) {
    if (existsSync(projectDir)) throw new Error(`工程目录已存在但不是本项目：${projectDir}；请更换 CJZBAI_PROJECT_DIR`);
    progress(`正在从 GitHub 克隆工程到 ${projectDir}`);
    mkdirSync(stateDir, { recursive: true });
    await run('git', ['clone', '--depth', '1', repoUrl, projectDir], { cwd: stateDir });
  }
  if (!existsSync(join(projectDir, 'captured', 'index.html')) || !existsSync(join(projectDir, 'evidence', 'ui-config-assets.json'))) {
    await downloadAssets();
  }
  if (!existsSync(join(projectDir, 'node_modules', 'three'))) {
    progress('正在安装 JavaScript 依赖（npm ci）');
    await run(npmBin, ['ci', '--no-audit', '--no-fund']);
  }
  if (!existsSync(join(projectDir, 'dist', 'index.html'))) {
    progress('正在构建本地前端（npm run build）');
    await run(npmBin, ['run', 'build']);
  }
  if (relief && !existsSync(join(projectDir, '.venv-geometry', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))) {
    progress('正在准备浮雕环境（Python + 深度模型，约 100 MB）');
    await run(npmBin, ['run', 'setup:geometry']);
  }

  const running = await health();
  if (running) return running; // 已有实例（含用户自己启动的）直接复用，不改动其配置
  const pid = readPid();
  if (pid) {
    const info = await waitHealth(15); // 可能正在启动中
    if (info) return info;
    await stopOwnedServer();
  }
  progress('正在启动本地服务');
  await startServer();
  const info = await waitHealth(30);
  if (!info) {
    let tail = '';
    try { tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch {}
    throw new Error(`本地服务启动失败（端口 ${port} 可能被占用，可设置 CJZBAI_PORT）。日志：${tail}`);
  }
  return info;
}

// ---------- 业务工具 ----------

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

async function uploadBytes(bytes, type, name) {
  if (bytes.length > 29 * 1024 * 1024) throw new Error('参考图不能超过 29 MiB');
  const form = new FormData();
  form.set('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${baseUrl}/api/upload/uploadDraw`, { method: 'POST', headers: { Origin: baseUrl }, body: form, signal: AbortSignal.timeout(120000) });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || '参考图上传失败');
  return data.data.url;
}

// 输入支持：本地文件路径、http(s) 图片 URL、本服务已有的 /uploads|/generated|/media URL。
async function resolveImage(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('参考图必须是文件路径或 URL');
  if (input.startsWith(baseUrl) && /^\/(uploads|generated|media)\//.test(new URL(input).pathname)) return input;
  let bytes, type, name;
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`参考图下载失败（HTTP ${res.status}）：${input}`);
    bytes = Buffer.from(await res.arrayBuffer());
    type = (res.headers.get('content-type') || '').split(';')[0];
    if (!Object.values(MIME).includes(type)) type = MIME[extname(new URL(input).pathname).toLowerCase()] || 'image/png';
    name = 'reference' + (Object.entries(MIME).find(([, v]) => v === type)?.[0] || '.png');
  } else {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`参考图文件不存在：${path}`);
    bytes = await readFile(path);
    type = MIME[extname(path).toLowerCase()];
    if (!type) throw new Error('参考图仅支持 PNG / JPEG / WEBP / SVG');
    name = path.split('/').pop();
  }
  return uploadBytes(bytes, type, name);
}

async function busyError() {
  try {
    const page = await api('GET', '/api/draw/comfyuiTask/page?page=1&limit=10');
    const busy = (page.data?.list || []).find(t => ![2, 4, 6, 7, 8].includes(t.status));
    if (busy) return new Error(`本地服务同一时间只允许一个生成任务（进行中任务 task_id=${busy.id}，可用 get_task 等待完成）`);
  } catch {}
  return new Error('本地服务同一时间只允许一个生成任务，请等待当前任务完成后再提交');
}

function localPath(url) {
  try {
    const parsed = new URL(url, baseUrl);
    const decode = p => decodeURIComponent(p);
    if (parsed.pathname.startsWith('/generated/')) return join(projectDir, 'data', 'generated', decode(parsed.pathname.slice('/generated/'.length)));
    if (parsed.pathname.startsWith('/uploads/')) return join(projectDir, 'data', 'uploads', decode(parsed.pathname.slice('/uploads/'.length)));
    if (parsed.pathname.startsWith('/media/')) return join(projectDir, 'dist', decode(parsed.pathname.slice(1)));
  } catch {}
  return null;
}

function withLocal(url) {
  return typeof url === 'string' && url.startsWith(baseUrl) ? { url, local_path: localPath(url) } : url;
}

function formatTask(task) {
  const status = { 8: 'succeeded', 6: 'failed', 7: 'interrupted', 2: 'cancelled', 4: 'cancelled' }[task.status] || 'running';
  const result = {
    task_id: task.id,
    status,
    app_number: task.appNumber,
    prompt: task.prompt,
    provider_model: task.providerModel,
    create_date: task.createDate,
  };
  if (status === 'running') result.progress = task.progress || '排队中';
  if (task.errorMsg) result.error = task.errorMsg;
  if (task.finishTime) result.finish_time = task.finishTime;
  if (typeof task.output === 'string') result.output = withLocal(task.output);
  else if (task.output && typeof task.output === 'object') {
    result.output = Object.fromEntries(Object.entries(task.output).map(([k, v]) => [k, Array.isArray(v) ? v.map(withLocal) : withLocal(v)]));
  }
  if (task.artifacts) result.artifacts = Object.fromEntries(Object.entries(task.artifacts).map(([k, v]) => [k, withLocal(v)]));
  if (task.metadata) result.metadata = task.metadata;
  return result;
}

const TERMINAL = [2, 4, 6, 7, 8];

async function getTask(taskId, waitSeconds = 0) {
  await ensureReady();
  const wait = Math.max(0, Math.min(110, Number(waitSeconds) || 0));
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const res = await api('GET', `/api/draw/comfyuiTask/${encodeURIComponent(taskId)}`);
    if (res.code !== 0) throw new Error(res.msg || '任务查询失败');
    const task = res.data;
    if (TERMINAL.includes(task.status) || Date.now() >= deadline) return formatTask(task);
    await sleep(3000);
  }
}

async function openWorkspace(openBrowser) {
  await ensureReady();
  const url = `${baseUrl}/workspace/2020`;
  if (openBrowser) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { await execFileAsync(command, args); } catch (e) { log('打开系统浏览器失败：' + e.message); }
  }
  return { url, home: baseUrl + '/', note: 'url 可直接在内嵌浏览器中打开；智能工坊入口 /workspace/2020，首页 /' };
}

async function status() {
  const installed = existsSync(join(projectDir, 'server.mjs'));
  const info = await health();
  const result = {
    project_dir: projectDir,
    mode: 'client-model', // 本 MCP 不调用任何模型；提示词交给调用方 Agent 生成
    installed,
    frontend_assets: existsSync(join(projectDir, 'captured', 'index.html')),
    built: existsSync(join(projectDir, 'dist', 'index.html')),
    dependencies: existsSync(join(projectDir, 'node_modules', 'three')),
    render_previews: existsSync(join(projectDir, '.venv-geometry', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')),
    server_running: Boolean(info),
    port,
    workspace_url: `${baseUrl}/workspace/2020`,
  };
  if (!installed) result.hint = '工程尚未安装，调用 setup 或任意工具会自动从 GitHub 克隆并安装';
  else if (!info) result.hint = '本地服务未运行，调用 setup 或任意生成工具会自动启动';
  return result;
}

// ---------- 工具定义 ----------

const waitSecondsSchema = { type: 'number', description: '提交后同步等待结果的秒数（0-110，默认 0 立即返回 task_id）。超时未完成时返回 running，可继续用 get_task 轮询', minimum: 0, maximum: 110 };

const TOOLS = [
  {
    name: 'setup',
    description: '安装并启动无觉珠宝 AI 本地版：从 GitHub 克隆工程、下载前端资源包、npm 安装构建、启动本地服务。幂等，可重复调用；首次约需数分钟（下载约 1.3 GB 前端资源）。本服务不读取、不写入任何模型配置或密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        relief: { type: 'boolean', description: '是否同时准备 Python 几何环境（三视角预览渲染，约 100 MB）。3D 自评修正需要它；未安装时自评自动跳过', default: false },
      },
    },
  },
  {
    name: 'status',
    description: '查看安装状态与本地服务健康状态（不触发安装，不返回密钥）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'prepare_image',
    description: '文生图/图生图（第一步）：返回合成好的出图提示词与参考图 URL。本服务不出图，请调用方 Agent 用自己的图像生成能力按 prompt 出图，再调用 submit_image 回传保存。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '设计需求描述，写清材质、宝石、镶嵌结构与风格' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 4, description: '可选参考图（本地路径或 URL），图生图/精修/融合时传入' },
        aspect_ratio: { type: 'string', description: '画幅比例，如 1:1、3:4' },
        size: { type: 'string', enum: ['1K', '2K'], description: '清晰度档位，默认 2K' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'submit_image',
    description: '回传客户端模型生成的图片（本地文件路径、URL 或 data URL），服务端校验保存并登记任务历史，返回展示 URL 与页面地址。须先调 prepare_image。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'prepare_image 返回的 task_id' },
        image: { type: 'string', description: '生成的图片：本地文件绝对路径、http(s) URL 或 data:image/...;base64 字符串' },
      },
      required: ['task_id', 'image'],
    },
  },
  {
    name: 'prepare_3d',
    description: '文生3D/图生3D（第一步）：返回建模提示词（system_prompt / user_prompt）与参考图 URL。本服务不调模型，请调用方 Agent 用自己的大模型按提示词输出建模 JSON，再调用 submit_3d 回传；服务端本地构建几何并可能返回自评修正提示词，循环直到完成。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '建模需求，务必包含必要尺寸（如戒圈直径 17mm、主石 8mm）；text 模式必填' },
        image: { type: 'string', description: '参考图（本地路径或 URL）；传入时默认 image 模式，先返回结构分析提示词' },
        mode: { type: 'string', enum: ['text', 'image'], description: '默认按是否传 image 自动选择' },
        refine_rounds: { type: 'number', minimum: 0, maximum: 2, description: '渲染自评修正轮数，默认 1；0 跳过自评（无 Python 环境时自动跳过）' },
      },
    },
  },
  {
    name: 'submit_3d',
    description: '回传客户端大模型的输出（结构分析 JSON / CadModel JSON / 评审结论 JSON，取决于当前 stage）。服务端校验构建：可能返回下一阶段提示词（继续让客户端模型生成），或返回最终 GLB/STL/DXF/JSON 与展示页面。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'prepare_3d 返回的 task_id' },
        output: { description: '客户端模型返回的 JSON（对象或字符串均可，按当前 stage 的契约：分析 parts / CadModel / verdict）' },
      },
      required: ['task_id', 'output'],
    },
  },
  {
    name: 'get_task',
    description: '查询生成任务状态与结果。status=succeeded 时返回结果 URL 与本地文件路径（图片在 data/generated/，3D 含 GLB/STL/DXF/JSON）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '提交任务时返回的 task_id' },
        wait_seconds: waitSecondsSchema,
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: '查看最近的生成任务历史（含网页端提交的任务）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 10，最大 100', default: 10 } },
    },
  },
  {
    name: 'open_workspace',
    description: '确保本地服务已启动，返回可在内嵌浏览器打开的工作台 URL（默认不弹系统浏览器）。',
    inputSchema: {
      type: 'object',
      properties: {
        open_browser: { type: 'boolean', description: 'true 时同时用系统默认浏览器打开页面', default: false },
      },
    },
  },
];

// 本地文件/远程 URL 读成 data URL，供 agent 图片回传。
async function imageToDataUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('缺少图片');
  if (input.startsWith('data:') || input.startsWith(baseUrl)) return input;
  let bytes, type;
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）：${input}`);
    bytes = Buffer.from(await res.arrayBuffer());
    type = (res.headers.get('content-type') || 'image/png').split(';')[0];
  } else {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`图片文件不存在：${path}`);
    bytes = await readFile(path);
    type = MIME[extname(path).toLowerCase()];
    if (!type) throw new Error('图片仅支持 PNG / JPEG / WEBP / SVG');
  }
  if (bytes.length > 29 * 1024 * 1024) throw new Error('图片不能超过 29 MiB');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function callTool(name, args) {
  switch (name) {
    case 'setup': {
      await ensureReady({ relief: Boolean(args.relief) });
      return { ok: true, mode: 'client-model', workspace_url: `${baseUrl}/workspace/2020`, project_dir: projectDir, note: '本服务不调用大模型；用 prepare_image / prepare_3d 取提示词，由你自己的模型生成后回传' };
    }
    case 'status':
      return status();
    case 'prepare_image': {
      if (!String(args.prompt || '').trim()) throw new Error('缺少 prompt');
      await ensureReady();
      const images = [];
      for (const image of (args.images || []).slice(0, 4)) images.push(await resolveImage(image));
      const res = await api('POST', '/api/agent/image/prepare', { prompt: args.prompt, images, aspectRatio: args.aspect_ratio, imageSize: args.size });
      if (res.code === 40901) throw await busyError();
      if (res.code !== 0) throw new Error(res.msg || '图片任务准备失败');
      return res.data;
    }
    case 'submit_image': {
      if (!args.task_id) throw new Error('缺少 task_id');
      await ensureReady();
      const image = await imageToDataUrl(args.image);
      const res = await api('POST', '/api/agent/image/submit', { task_id: args.task_id, image });
      if (res.code !== 0) throw new Error(res.msg || '图片回传失败');
      return res.data;
    }
    case 'prepare_3d': {
      await ensureReady();
      const body = { mode: args.mode || (args.image ? 'image' : 'text'), prompt: args.prompt };
      if (args.image) body.imageUrl = await resolveImage(args.image);
      if (args.refine_rounds !== undefined) body.refineRounds = args.refine_rounds;
      const res = await api('POST', '/api/agent/3d/prepare', body);
      if (res.code === 40901) throw await busyError();
      if (res.code !== 0) throw new Error(res.msg || '3D 任务准备失败');
      return res.data;
    }
    case 'submit_3d': {
      if (!args.task_id) throw new Error('缺少 task_id');
      if (args.output === undefined || args.output === null) throw new Error('缺少 output（客户端模型返回的 JSON）');
      await ensureReady();
      const res = await api('POST', '/api/agent/3d/submit', { task_id: args.task_id, output: args.output });
      if (res.code !== 0) throw new Error(res.msg || '建模结果回传失败');
      return res.data;
    }
    case 'get_task': {
      if (!args.task_id) throw new Error('缺少 task_id');
      return getTask(args.task_id, args.wait_seconds);
    }
    case 'list_tasks': {
      await ensureReady();
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
      const res = await api('GET', `/api/draw/comfyuiTask/page?page=1&limit=${limit}`);
      if (res.code !== 0) throw new Error(res.msg || '任务列表查询失败');
      return { total: res.data.total, tasks: res.data.list.map(t => ({ task_id: t.id, status: { 8: 'succeeded', 6: 'failed', 7: 'interrupted' }[t.status] || 'running', app_number: t.appNumber, prompt: t.prompt, create_date: t.createDate, output: typeof t.output === 'string' ? withLocal(t.output) : undefined })) };
    }
    case 'open_workspace':
      return openWorkspace(Boolean(args.open_browser));
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ---------- MCP stdio 协议 ----------

let progressToken = null;
function progress(message) {
  log(message);
  if (progressToken !== null && progressToken !== undefined) {
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, message } });
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const INSTRUCTIONS = [
  '无觉珠宝 AI 本地版 MCP：提供珠宝文生图 / 图生图 / 文生3D / 图生3D 的提示词、参考图与本地几何算力，并返回可展示的页面 URL。',
  '本服务不调用任何大模型，也不需要 API 密钥；图片与 3D 建模结果必须由你（调用方 Agent）用自己的模型生成：',
  '  图片：prepare_image 取出图提示词与参考图 → 你用自己的图像生成能力出图 → submit_image 回传图片。',
  '  3D：prepare_3d 取建模提示词 → 你用自己的大模型输出建模 JSON → submit_3d 回传；服务端本地构建几何，可能返回修正或自评提示词，循环直到 status=succeeded。',
  '完成后用返回的 view_url（图片 /workspace/2006，3D /workspace/2011）在内嵌浏览器展示；结果文件在运行实例 data/generated/。',
  '首次调用会自动从 GitHub 克隆工程、下载前端资源并安装启动（需数分钟）；同一时间只允许一个生成任务。',
].join('\n');

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    reply(id, {
      protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    progressToken = params?._meta?.progressToken ?? null;
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      log(`工具 ${params?.name} 失败：${e.message}`);
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: e.message }, null, 2) }], isError: true });
    } finally {
      progressToken = null;
    }
    return;
  }
  if (id !== undefined && id !== null) replyError(id, -32601, `不支持的方法：${method}`);
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return replyError(null, -32700, 'JSON 解析失败'); }
  handleMessage(message).catch(e => {
    log('协议处理异常：' + e.stack);
    if (message.id !== undefined && message.id !== null) replyError(message.id, -32603, e.message);
  });
});
lines.on('close', () => process.exit(0));
log(`MCP 服务就绪：projectDir=${projectDir} port=${port}`);