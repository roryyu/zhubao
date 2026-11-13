// Alibaba Cloud Tripo adapter. No task is submitted until every input is
// validated and every local image has an explicitly configured upload route.
// API: https://help.aliyun.com/en/model-studio/tripo-3d-generation-api-reference
// Optional temporary upload protocol:
// https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MODELS = new Set(['Tripo/Tripo-P1.0', 'Tripo/Tripo-H3.1']);
const CREATE_PATH = '/api/v1/services/aigc/video-generation/3d-generation';

function safeMessage(value, key = '') {
  let text = typeof value === 'string' ? value : '';
  if (key) text = text.replaceAll(key, '[REDACTED]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]')
    .replace(/(?:https?|oss):\/\/[^\s"'<>]+/g, '[URL]')
    .replace(/[\u0000-\u001f]/g, ' ').slice(0, 400);
}

function serviceUrl(config, pathname) {
  let url;
  try { url = new URL(config.base); } catch { throw new Error('3D 模型接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('3D 模型接口地址无效');
  url.pathname = pathname; url.search = ''; url.hash = '';
  return url;
}

export function isPublicImageUrl(value) {
  let url; try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !host.includes(':')) return false;
  if (host === '::1' || host === '::' || /^(fc|fd|fe[89ab])/i.test(host) || host.startsWith('::ffff:')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

async function boundedBytes(response, limit, signal) {
  const announced = Number(response.headers.get('content-length'));
  if (announced > limit) { await response.body?.cancel(); throw new Error('3D 服务返回的文件超过本地大小限制'); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    signal?.throwIfAborted(); length += chunk.length;
    if (length > limit) throw new Error('3D 服务返回的文件超过本地大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readPacket(response, config, signal) {
  const bytes = await boundedBytes(response, 1024 * 1024, signal);
  let packet; try { packet = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!response.ok || !packet || packet.code && !packet.output) {
    const detail = safeMessage(packet?.message || packet?.error?.message, config.key);
    throw new Error(`3D 服务调用失败（HTTP ${response.status}）${detail ? '：' + detail : ''}`);
  }
  return packet;
}

function imageKind(reference, source = '') {
  if (reference?.type === 'image/png' || /\.png(?:$|\?)/i.test(source)) return 'png';
  if (reference?.type === 'image/jpeg' || /\.(jpg|jpeg)(?:$|\?)/i.test(source)) return 'jpeg';
  if (!reference) return null; // A public single-image URL is validated by Tripo.
  throw new Error('Tripo 输入仅支持 PNG 或 JPEG，请先转换参考图');
}

async function uploadTemporary(reference, config, signal) {
  const policyUrl = config.uploadPolicyUrl ? new URL(config.uploadPolicyUrl) : serviceUrl(config, '/api/v1/uploads');
  if (!['http:', 'https:'].includes(policyUrl.protocol) || policyUrl.username || policyUrl.password) throw new Error('3D 临时上传接口地址无效');
  policyUrl.searchParams.set('action', 'getPolicy'); policyUrl.searchParams.set('model', config.model);
  const packet = await readPacket(await fetch(policyUrl, { headers: { Authorization: `Bearer ${config.key}`, 'Content-Type':'application/json' }, signal }), config, signal);
  const policy = packet.data;
  const required = ['upload_dir','upload_host','oss_access_key_id','signature','policy','x_oss_object_acl','x_oss_forbid_overwrite'];
  if (!policy || required.some(k => typeof policy[k] !== 'string')) throw new Error('3D 临时上传未返回完整凭据；请确认该模型支持临时存储或配置公网资源地址');
  if (policy.x_oss_object_acl !== 'private') throw new Error('3D 临时上传策略不是私有访问，已停止上传；不会自动公开参考图');
  const upload = new URL(policy.upload_host);
  if (!['http:','https:'].includes(upload.protocol) || upload.username || upload.password) throw new Error('3D 临时上传返回的地址无效');
  if (reference.bytes.length > Number(policy.max_file_size_mb || 20) * 1024 * 1024) throw new Error('参考图超过临时存储允许的大小');
  const kind = imageKind(reference), filename = randomUUID() + (kind === 'jpeg' ? '.jpg' : '.png');
  const key = policy.upload_dir.replace(/\/$/,'') + '/' + filename;
  const form = new FormData();
  for (const [name, value] of Object.entries({OSSAccessKeyId:policy.oss_access_key_id, Signature:policy.signature, policy:policy.policy, 'x-oss-object-acl':policy.x_oss_object_acl, 'x-oss-forbid-overwrite':policy.x_oss_forbid_overwrite, key, success_action_status:'200'})) form.append(name,value);
  form.append('file', new Blob([reference.bytes], { type: reference.type }), filename);
  // Do not forward the model API key to the OSS upload host.
  const response = await fetch(upload, { method:'POST',body:form,signal });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`3D 参考图临时上传失败（HTTP ${response.status}）`);
  return { url:'oss://' + key, type:kind, temporary:true };
}

async function inputImage(source, reference, config, signal) {
  if (reference?.bytes && reference.bytes.length > 20 * 1024 * 1024) throw new Error('Tripo 参考图不能超过 20 MB');
  const kind = imageKind(reference, source);
  if (reference?.publicUrl && isPublicImageUrl(reference.publicUrl)) return {url:reference.publicUrl,type:kind};
  if (isPublicImageUrl(source)) return {url:source,type:kind};
  if (!reference?.bytes) throw new Error('3D 参考图必须先读取本地文件，不能把 localhost 地址交给云端');
  if (typeof config.resolveReference === 'function') {
    const url = await config.resolveReference(reference, { model:config.model, signal });
    if (!isPublicImageUrl(url)) throw new Error('3D 图片上传器未返回公网 HTTP(S) URL');
    return {url,type:kind};
  }
  if (config.publicAssetBaseUrl && reference.publicPath) {
    const url = new URL(reference.publicPath.replace(/^\//,''), config.publicAssetBaseUrl.replace(/\/?$/,'/')).href;
    if (!isPublicImageUrl(url)) throw new Error('3D 公网资源地址不能是本机或局域网地址');
    return {url,type:kind};
  }
  if (config.uploadMode === 'dashscope-temporary') return uploadTemporary(reference, config, signal);
  throw new Error('Tripo 需要公网参考图。请配置 3D 临时上传或公网 OSS 资源地址；本地图片尚未提交到云端');
}

export async function buildTripoRequest({ params, config, references = [], signal }) {
  if (!MODELS.has(config.model)) throw new Error('3D 模型须为 Tripo/Tripo-P1.0 或 Tripo/Tripo-H3.1');
  const input = {}, parameters = { quad:false };
  let temporary = false;
  if (params.mode === 'text') {
    const prompt = String(params.additionalPrompt || params.prompt || '').trim();
    if (!prompt || [...prompt].length > 1024) throw new Error('Tripo 文本描述须为 1～1024 个字符');
    input.prompt = prompt;
  } else if (params.mode === 'multiview') {
    const views = params.multiViewImages;
    if (!Array.isArray(views) || views.length < 2 || views.length > 4 || !views.some(v => v.viewType === 'front')) throw new Error('Tripo 多视图需要正面及至少一个其他视图，共 2～4 张');
    const order = ['front','left','back','right'];
    if (new Set(views.map(v=>v.viewType)).size !== views.length || views.some(v=>!order.includes(v.viewType))) throw new Error('3D 多视图名称重复或无效');
    input.images = [];
    for (const viewType of order) {
      const index = views.findIndex(v=>v.viewType === viewType);
      if (index === -1) { input.images.push({}); continue; }
      const image = await inputImage(views[index].viewImageUrl, references[index], config, signal);
      if (!image.type) throw new Error('多视图图片须指定 PNG 或 JPEG 类型');
      input.images.push({ type:image.type, file_token:image.url }); temporary ||= !!image.temporary;
    }
  } else {
    if (!params.imageUrl) throw new Error('请上传 3D 重建参考图');
    const image = await inputImage(params.imageUrl, references[0], config, signal);
    input.image = image.url; temporary = !!image.temporary;
  }
  const geometryOnly = String(params.generateType || '').toLowerCase() === 'geometry';
  parameters.texture = !geometryOnly;
  parameters.pbr = !geometryOnly && params.enablePBR === true;
  if (!geometryOnly) parameters.texture_quality = ['standard','detailed','extreme'].includes(params.textureQuality) ? params.textureQuality : 'standard';
  if (params.faceCount != null && params.faceCount !== '') {
    const faces = Number(params.faceCount), max = config.model === 'Tripo/Tripo-P1.0' ? 20000 : params.geometryQuality === 'ultra' ? 2000000 : 1500000;
    if (!Number.isInteger(faces) || faces < 50 || faces > max) throw new Error(`当前 3D 模型的面数须为 50～${max}；不会静默修改所选面数`);
    parameters.face_limit = faces;
  }
  if (config.model === 'Tripo/Tripo-H3.1') parameters.geometry_quality = params.geometryQuality === 'ultra' ? 'ultra' : 'standard';
  return { body:{model:config.model,input,parameters}, temporary };
}

export function validateGlb(bytes) {
  if (bytes.length < 24 || bytes.toString('ascii',0,4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('3D 服务没有返回完整的 GLB 2.0 文件');
  if (bytes.toString('ascii',16,20) !== 'JSON') throw new Error('GLB 缺少 JSON 场景数据');
  const jsonLength = bytes.readUInt32LE(12);
  if (20 + jsonLength > bytes.length) throw new Error('GLB 场景长度不正确');
  let data; try { data = JSON.parse(bytes.toString('utf8',20,20+jsonLength)); } catch { throw new Error('GLB 场景 JSON 无效'); }
  if (!Array.isArray(data.meshes) || !data.meshes.some(m=>m.primitives?.some(p=>p.attributes?.POSITION != null))) throw new Error('GLB 文件不包含可显示的网格');
  if (data.buffers?.some(b=>b.uri && !b.uri.startsWith('data:')) || data.images?.some(i=>i.uri && !i.uri.startsWith('data:'))) throw new Error('GLB 包含未下载的外部资源，不能作为完整本地模型保存');
  for (const mesh of data.meshes) for (const primitive of mesh.primitives || []) {
    const position = data.accessors?.[primitive.attributes?.POSITION];
    if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || position.count < 3 || !data.bufferViews?.[position.bufferView]) throw new Error('GLB 顶点数据不完整');
  }
  return { version:2, bytes:bytes.length, meshes:data.meshes.length, materials:data.materials?.length || 0 };
}

export async function generateTripo({ params, config, references = [], outputDir, taskId, onProgress = async () => {}, signal }) {
  if (!config.key || !config.base) throw new Error('请配置独立 3D 服务地址、API Key 和 Tripo 模型');
  if (!/^[\w-]{1,100}$/.test(taskId || '')) throw new Error('本地 3D 任务 ID 无效');
  const timeout = Number(config.timeout || 600000);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600000) throw new Error('3D 请求超时时间无效');
  const requestSignal = signal ? AbortSignal.any([signal,AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const auth = {Authorization:`Bearer ${config.key}`};
  let remoteTaskId = config.remoteTaskId || null;
  try {
    if (!remoteTaskId) {
      const {body, temporary} = await buildTripoRequest({params,config,references,signal:requestSignal});
      let packet;
      try {
        packet = await readPacket(await fetch(serviceUrl(config,CREATE_PATH), {method:'POST',headers:{...auth,'Content-Type':'application/json','X-DashScope-Async':'enable',...(temporary ? {'X-DashScope-OssResourceResolve':'enable'} : {})},body:JSON.stringify(body),signal:requestSignal}),config,requestSignal);
      } catch (error) {
        if (/^3D 服务调用失败/.test(error.message)) throw error;
        throw new Error('3D 任务提交结果未知，请先检查服务商控制台；程序未自动重复提交');
      }
      remoteTaskId = packet.output?.task_id;
      if (typeof remoteTaskId !== 'string' || !/^[\w-]{1,200}$/.test(remoteTaskId)) throw new Error('3D 任务提交未返回有效 task_id，请先检查控制台，勿重复提交');
      // Must be awaited: the caller persists this ID before any polling. A
      // resumed job passes config.remoteTaskId and never posts another task.
      await onProgress({remoteTaskId,status:packet.output?.task_status || 'PENDING',phase:'submitted'});
      await delay(Number(config.initialPollMs ?? 10000),undefined,{signal:requestSignal});
    } else if (!/^[\w-]{1,200}$/.test(remoteTaskId)) throw new Error('远程 3D 任务 ID 无效');
    let result;
    for (;;) {
      requestSignal.throwIfAborted();
      const packet = await readPacket(await fetch(serviceUrl(config,'/api/v1/tasks/' + encodeURIComponent(remoteTaskId)),{headers:auth,signal:requestSignal}),config,requestSignal);
      const output = packet.output;
      await onProgress({remoteTaskId,status:output?.task_status || 'UNKNOWN',phase:'polling'});
      if (output?.task_status === 'SUCCEEDED') { result = output.results?.[0]; break; }
      if (['FAILED','CANCELED','UNKNOWN'].includes(output?.task_status)) throw new Error(`3D 任务${output.task_status === 'UNKNOWN' ? '不存在或已过期' : '未完成'}：${safeMessage(output.message || output.code || output.task_status,config.key)}`);
      if (!['PENDING','RUNNING'].includes(output?.task_status)) throw new Error('3D 服务返回了无法识别的任务状态');
      await delay(Number(config.pollIntervalMs ?? 15000),undefined,{signal:requestSignal});
    }
    const modelUrl = result?.pbr_model_url || result?.model_url || result?.base_model_url;
    if (typeof modelUrl !== 'string' || !/^https?:\/\//.test(modelUrl)) throw new Error('3D 任务完成但没有可下载的模型文件');
    const response = await fetch(modelUrl,{signal:requestSignal}); // no API key on signed CDN requests
    if (!response.ok) { await response.body?.cancel(); throw new Error(`3D 模型下载失败（HTTP ${response.status}），保留远程任务 ID 可稍后重取`); }
    const bytes = await boundedBytes(response,Number(config.maxModelBytes || 300*1024*1024),requestSignal);
    const glb = validateGlb(bytes);
    await mkdir(outputDir,{recursive:true});
    const modelPath = resolve(outputDir,taskId + '.glb');
    await writeFile(modelPath + '.partial',bytes); await rename(modelPath + '.partial',modelPath);
    let previewPath = null;
    if (typeof result.rendered_image_url === 'string' && /^https?:\/\//.test(result.rendered_image_url)) {
      try {
        const response = await fetch(result.rendered_image_url,{signal:requestSignal});
        if (response.ok) {
          const image = await boundedBytes(response,30*1024*1024,requestSignal);
          const ext = image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png' : image[0]===255 && image[1]===216 ? '.jpg' : image.toString('ascii',0,4)==='RIFF' && image.toString('ascii',8,12)==='WEBP' ? '.webp' : null;
          if (ext) { previewPath = resolve(outputDir,taskId + '-preview' + ext); await writeFile(previewPath,image); }
        } else await response.body?.cancel();
      } catch (error) { if (requestSignal.aborted) throw error; }
    }
    return {modelPath,previewPath,metadata:{provider:'Alibaba Cloud Tripo',model:config.model,remoteTaskId,...glb,manufacturingValidated:false},artifacts:[{format:'GLB',path:modelPath}]};
  } catch (error) {
    if (remoteTaskId) error.remoteTaskId = remoteTaskId;
    if (requestSignal.aborted) {
      const stopped = new Error('3D 等待已停止或超时；远程任务可能仍在运行，请使用保留的任务 ID 查询，不要重复提交');
      stopped.remoteTaskId = remoteTaskId; stopped.code = 'TRIPO_WAIT_ABORTED'; throw stopped;
    }
    throw error;
  }
}
