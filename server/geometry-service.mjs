import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { modelConfig, configured } from './model-config.mjs';

const execFileAsync = promisify(execFile);
export const geometryRoot = fileURLToPath(new URL('../', import.meta.url));
export const reliefFormats = { 2020: ['TIF','EXR','PNG','STL','GLB'], 2022: ['DXF','STL','GLB','TIF'] };
export function geometryConfig() {
  const chat = modelConfig('chat');
  return {
    provider: process.env.MODEL3D_PROVIDER || 'qwen-cad',
    base: (process.env.MODEL3D_BASE_URL || chat.base).replace(/\/+$/, ''),
    key: process.env.MODEL3D_API_KEY || chat.key,
    model: process.env.MODEL3D_MODEL || chat.model,
    timeout: Number(process.env.MODEL3D_TIMEOUT_MS || 180000),
    allowNoKey: process.env.MODEL3D_ALLOW_NO_KEY === 'true',
    refineRounds: Number(process.env.MODEL3D_REFINE_ROUNDS ?? 1),
    analyze: process.env.MODEL3D_ANALYZE !== 'false',
    maxTokens: Number(process.env.MODEL3D_MAX_TOKENS || 16000),
  };
}
export function geometryCapabilities() {
  const c = geometryConfig();
  return {
    relief: { configured: existsSync(resolve(geometryRoot,'.venv-geometry/bin/python')) && existsSync(resolve(geometryRoot,'data/models/depth-anything-v2-small.onnx')), processor: 'Depth Anything V2 Small + closed height field', formats: reliefFormats },
    model3d: { configured: configured(c), provider: c.provider, model: c.model, mode: c.provider === 'qwen-cad' ? 'parametric-csg' : 'dedicated-reconstruction' },
  };
}
export function validateGeometry(number, params) {
  if (number === 2011) {
    const c = geometryConfig();
    if (!['qwen-cad','tripo-dashscope'].includes(c.provider)) return 'MODEL3D_PROVIDER 请选择 qwen-cad 或 tripo-dashscope';
    if (!configured(c)) return '请先配置 CHAT 模型，或单独配置 MODEL3D_BASE_URL、MODEL3D_API_KEY、MODEL3D_MODEL';
    if (!['text','image','multiview'].includes(params.mode || 'image')) return '3D 输入模式无效';
    if (params.mode === 'text' && !String(params.additionalPrompt || params.prompt || '').trim()) return '请输入首饰建模需求和必要尺寸';
    return '';
  }
  if (!reliefFormats[number]?.includes(params.format)) return '请选择实际支持的标准格式；不支持伪造 VSM、VS3D、JDP 或 AI 文件';
  if (!['浅浮雕','中浮雕','高浮雕'].includes(params.mode)) return '请选择浅、中或高浮雕';
  const length = Number(params.modelLengthMm ?? 100);
  if (!Number.isFinite(length) || length < 0.1 || length > 10000) return '成品画布长边须为 0.1～10000 mm';
  if (!geometryCapabilities().relief.configured) return '浮雕本地模型尚未准备好，请先运行 npm run setup:geometry';
  return '';
}
export function geometryReferences(number, params) {
  if (number !== 2011) return params.imageUrl ? [params.imageUrl] : [];
  if (params.mode === 'text') return [];
  if (params.mode === 'multiview') return (params.multiViewImages || []).map(item => item.viewImageUrl);
  return params.imageUrl ? [params.imageUrl] : [];
}

export async function generateGeometry({ root, task, references, onProgress }) {
  const out = resolve(root,'data/generated',task.id);
  await mkdir(out,{recursive:true});
  const url = path => {
    const rel = relative(resolve(root,'data/generated'),resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('建模输出位置不正确');
    return '/generated/' + rel.replaceAll('\\','/').split('/').map(encodeURIComponent).join('/');
  };
  if ([2020,2022].includes(task.appNumber)) {
    await onProgress('正在计算神经相对深度并生成浮雕网格');
    const image = references[0];
    if (!image) throw new Error('浮雕需要上传参考图');
    const longEdge = Number(task.params.modelLengthMm ?? 100);
    const request = { imagePath:image.path, outputDir:out, basename:task.id, mode:task.params.mode, feature:task.appNumber===2022?'lineart':'relief', longEdgeMm:longEdge, gridSize:128, depthModelPath:resolve(root,'data/models/depth-anything-v2-small.onnx') };
    const call = execFileAsync(resolve(root,'.venv-geometry/bin/python'),[resolve(root,'server/relief_worker.py')],{timeout:120000,maxBuffer:1024*1024});
    call.child.stdin.on('error',()=>{}); call.child.stdin.end(JSON.stringify(request));
    let result;
    try { result=JSON.parse((await call).stdout.trim()); }
    catch(e) {
      let reason='浮雕生成失败，请检查本地模型和图片';
      try { reason=JSON.parse(String(e.stderr||'').trim()).error || reason; } catch{}
      throw new Error(reason.replaceAll(root,'[项目目录]').slice(0,500));
    }
    const files=Object.fromEntries(Object.entries(result.files).map(([format,path])=>[format,url(path)]));
    return {
      output:{engineeringUrl:files[task.params.format],images:[url(result.previewPath),url(result.depthPath)],format:task.params.format,platformCost:0,modelUrl:files.GLB,files,metadataUrl:url(result.metadataPath)},
      artifacts:files,
      metadata:{method:result.method,scaleNote:result.scaleNote,manufacturingNote:result.manufacturingNote,stats:result.stats},
    };
  }
  const config=geometryConfig();
  // 多阶段管线（分析+建模+纠错+自评）的总时长上限高于单次调用超时。
  const signal=AbortSignal.timeout(Math.min(900000,config.timeout*5));
  await onProgress('正在根据输入构建真实 3D 几何');
  let result;
  if(config.provider==='qwen-cad') {
    const {generateCad}=await import('./cad-provider.mjs');
    result=await generateCad({params:task.params,references,config,outputDir:out,taskId:task.id,onProgress,signal});
  } else {
    const {generateTripo}=await import('./tripo-service.mjs');
    result=await generateTripo({params:task.params,references,config,outputDir:out,taskId:task.id,onProgress,signal});
  }
  const artifacts=Array.isArray(result.artifacts) ? Object.fromEntries(result.artifacts.map(a=>[a.format,url(a.path)])) : Object.fromEntries(Object.entries(result.artifacts||{}).map(([format,path])=>[format,url(path)]));
  return {output:url(result.modelPath),artifacts,metadata:result.metadata};
}
