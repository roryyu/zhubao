import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { geometryToTriangles, trianglesToDxf } from '../vendor/create-3d-things/cad-export.ts';
import { parseExtendedCadModel, expandCadModel } from './cad/dsl.mjs';
import { buildExtendedCadMesh } from './cad/mesh.mjs';
import { buildJewelrySystemPrompt, buildJewelryTextPrompt, buildJewelryImagePrompt, buildAnalysisSystemPrompt, buildAnalysisPrompt, buildCritiquePrompt } from './cad/prompts.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MAX_MODEL_BYTES = 200000;
const MAX_CORRECTION_ATTEMPTS = 2;

function safeProviderMessage(value, key) {
  let text = typeof value === 'string' ? value : '';
  if (key) text = text.replaceAll(key, '[REDACTED]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[\w-]+/g,'[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').replace(/[\u0000-\u001f]/g,' ').slice(0,400);
}

/** 解析扩展 CadModel（vendor 五图元的超集）。保留旧导出名供测试与复用。 */
export function parseCadModel(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_MODEL_BYTES) throw new Error('CAD 模型回复为空或超过 200 KB');
  let value; const trimmed = raw.trim();
  for (const candidate of [trimmed, /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]]) {
    if (!candidate) continue;
    try { value = JSON.parse(candidate); break; } catch {}
  }
  if (!value) throw new Error('CAD 模型没有返回有效 JSON，不会执行模型输出的代码');
  const { model, declaredNodes } = parseExtendedCadModel(value);
  return { model, nodeCount: declaredNodes };
}

function checkedTriangles(mesh) {
  const source = geometryToTriangles(mesh.geometry), triangles = [];
  for (let i=0;i<source.length;i+=9) {
    const a = new THREE.Vector3(...source.slice(i,i+3));
    const b = new THREE.Vector3(...source.slice(i+3,i+6));
    const c = new THREE.Vector3(...source.slice(i+6,i+9));
    if (new THREE.Vector3().crossVectors(b.sub(a),c.sub(a)).lengthSq() > 1e-16) triangles.push(...source.slice(i,i+9));
  }
  if (!triangles.length) throw new Error('CAD 布尔运算只得到退化面或空模型');
  return triangles;
}

function stlBytes(triangles) {
  const bytes = Buffer.alloc(84+triangles.length/9*50);
  bytes.write('CJZBAI parametric CSG; millimetres; Z-up; not manufacturing validated',0,80,'ascii');
  bytes.writeUInt32LE(triangles.length/9,80);
  for (let i=0,offset=84;i<triangles.length;i+=9,offset+=50) {
    const points = [0,3,6].map(j=>new THREE.Vector3(triangles[i+j],-triangles[i+j+2],triangles[i+j+1]));
    const normal = new THREE.Vector3().crossVectors(points[1].clone().sub(points[0]),points[2].clone().sub(points[0])).normalize();
    [...normal.toArray(),...points.flatMap(p=>p.toArray())].forEach((v,j)=>bytes.writeFloatLE(v,offset+j*4));
  }
  return bytes;
}

function glbBytes(mesh, metadata) {
  const geometry = mesh.geometry, positions = geometry.getAttribute('position');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const buffers=[],bufferViews=[],accessors=[];let offset=0;
  const addBuffer = (array,target) => {
    const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength), index=bufferViews.length;
    bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length,target}); buffers.push(bytes); offset+=bytes.length;
    const padding=(4-offset%4)%4;if(padding){buffers.push(Buffer.alloc(padding));offset+=padding;}
    return index;
  };
  const points=new Float32Array(positions.count*3),normalValues=new Float32Array(positions.count*3),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<positions.count;i++)for(let axis=0;axis<3;axis++){
    const point=[positions.getX(i),positions.getY(i),positions.getZ(i)][axis]*0.001;
    if(!Number.isFinite(point))throw new Error('CAD 顶点包含无效数值');
    points[i*3+axis]=point;min[axis]=Math.min(min[axis],point);max[axis]=Math.max(max[axis],point);
    normalValues[i*3+axis]=[normals.getX(i),normals.getY(i),normals.getZ(i)][axis];
  }
  accessors.push({bufferView:addBuffer(points,34962),componentType:5126,count:positions.count,type:'VEC3',min,max});
  accessors.push({bufferView:addBuffer(normalValues,34962),componentType:5126,count:positions.count,type:'VEC3'});
  const sourceMaterials = Array.isArray(mesh.material)?mesh.material:[mesh.material],extensionsUsed=new Set();
  const materials=sourceMaterials.map(m=>{
    const result={name:m.name||'material',doubleSided:m.side===THREE.DoubleSide,pbrMetallicRoughness:{baseColorFactor:[m.color?.r??0.8,m.color?.g??0.8,m.color?.b??0.8,m.opacity??1],metallicFactor:m.metalness??0,roughnessFactor:m.roughness??0.5}};
    if(m.opacity<1)result.alphaMode='BLEND';
    if(m.transmission>0){extensionsUsed.add('KHR_materials_transmission');result.extensions={KHR_materials_transmission:{transmissionFactor:m.transmission},KHR_materials_ior:{ior:m.ior||1.5}};extensionsUsed.add('KHR_materials_ior');}
    return result;
  });
  const index=geometry.getIndex(),available=index?index.count:positions.count,start=geometry.drawRange.start||0,end=Math.min(available,start+geometry.drawRange.count);
  const groups=geometry.groups.length?geometry.groups:[{start,count:end-start,materialIndex:0}],primitives=[];
  for(const group of groups){
    const from=Math.max(start,group.start),to=Math.min(end,group.start+group.count);
    if(to<=from)continue;
    const values=[];
    for(let i=from;i+2<to;i+=3){
      const ids=[0,1,2].map(j=>index?index.getX(i+j):i+j);
      const p=ids.map(id=>new THREE.Vector3(positions.getX(id),positions.getY(id),positions.getZ(id)));
      if(new THREE.Vector3().crossVectors(p[1].sub(p[0]),p[2].sub(p[0])).lengthSq()<=1e-16)continue;
      values.push(...ids);
    }
    if(!values.length)continue;
    const indices=accessors.length;accessors.push({bufferView:addBuffer(new Uint32Array(values),34963),componentType:5125,count:values.length,type:'SCALAR'});
    primitives.push({attributes:{POSITION:0,NORMAL:1},indices,material:Math.min(group.materialIndex||0,materials.length-1),mode:4});
  }
  if(!primitives.length)throw new Error('CAD 模型没有可导出的 GLB 三角面');
  const data={asset:{version:'2.0',generator:'cjzbai qwen-parametric-csg',extras:{units:'metre',sourceUnits:'millimetre',manufacturingValidated:false}},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:metadata.title||'Jewelry concept'}],meshes:[{primitives}],materials,buffers:[{byteLength:offset}],bufferViews,accessors,extras:metadata};
  if(extensionsUsed.size)data.extensionsUsed=[...extensionsUsed];
  let json=Buffer.from(JSON.stringify(data));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const bin=Buffer.concat(buffers),header=Buffer.alloc(20),binaryHeader=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+8+bin.length,8);header.writeUInt32LE(json.length,12);header.write('JSON',16);
  binaryHeader.writeUInt32LE(bin.length);binaryHeader.write('BIN\0',4);
  return Buffer.concat([header,json,binaryHeader,bin]);
}

export async function exportCadModel({ raw, outputDir, taskId, providerModel = 'local-test', appearance = 'Normal' }) {
  if(!/^[\w-]{1,100}$/.test(taskId||''))throw new Error('本地 CAD 任务 ID 无效');
  const {model,nodeCount}=parseCadModel(typeof raw==='string'?raw:JSON.stringify(raw));
  const {root,instances,expandedNodes}=expandCadModel(model);
  let mesh;
  try{
    mesh=buildExtendedCadMesh(root,{instances});mesh.updateMatrixWorld(true);
    if(appearance==='Geometry')for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
      material.color.set('#d2d2d2');material.metalness=0;material.roughness=0.65;material.transmission=0;material.opacity=1;material.transparent=false;
    }
    const triangles=checkedTriangles(mesh);
    mesh.geometry.computeBoundingBox();const size=mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    if([size.x,size.y,size.z].some(n=>!Number.isFinite(n)||n<0.001||n>1000))throw new Error('CAD 模型整体尺寸无效或超过 1000 mm');
    const metadata={method:'qwen-parametric-csg',pipeline:'analyze-build-critique-v2',providerModel,appearance,title:model.title||'首饰参数化概念模型',summary:model.summary||'',sourceUnits:'mm',glbUnits:'m',stlUnits:'mm',dxfUnits:'mm',boundsMm:size.toArray(),triangleCount:triangles.length/9,nodeCount,declaredNodeCount:nodeCount,expandedInstances:instances,expandedNodes,manufacturingValidated:false,limitations:['图片中的未见结构与尺寸由模型推断，不是测量结果','参数化实体对复杂有机造型仍为近似，自评修正不能保证设计级精度','GLB 使用标准 PBR 材质，原项目程序化表面纹理不写入文件'],sourceProject:'user local create-3d-things + server/cad extensions'};
    await mkdir(outputDir,{recursive:true});
    const artifacts=Object.fromEntries(['GLB','STL','DXF','JSON'].map(format=>[format,resolve(outputDir,taskId+'.'+format.toLowerCase())]));
    await Promise.all([writeFile(artifacts.GLB,glbBytes(mesh,metadata)),writeFile(artifacts.STL,stlBytes(triangles)),writeFile(artifacts.DXF,trianglesToDxf(triangles,'mm')),writeFile(artifacts.JSON,JSON.stringify(model,null,2))]);
    return {modelPath:artifacts.GLB,metadata,artifacts};
  }finally{if(mesh){mesh.geometry.dispose();for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])m.dispose();}}
}

/** 宽松解析模型返回的 JSON 对象；失败返回 null，由调用方决定降级。 */
function tolerantJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  for (const candidate of [trimmed, /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]]) {
    if (!candidate) continue;
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object') return value; } catch {}
  }
  return null;
}

async function renderPreviews(stlPath, outputDir, taskId, round) {
  const python = resolve(projectRoot, '.venv-geometry/bin/python');
  const worker = resolve(projectRoot, 'server/cad/preview.py');
  const request = { stlPath, outDir: outputDir, basename: `${taskId}-r${round}`, size: 512 };
  try {
    const call = execFileAsync(python, [worker], { timeout: 120000, maxBuffer: 1024 * 1024 });
    call.child.stdin.on('error', () => {});
    call.child.stdin.end(JSON.stringify(request));
    const result = JSON.parse((await call).stdout.trim());
    return Array.isArray(result.views) && result.views.length ? result.views : null;
  } catch {
    return null;
  }
}

export async function generateCad({ params, references = [], config, outputDir, taskId, onProgress = async()=>{}, signal }) {
  if(!config?.base||!config?.model||(!config?.key&&!config?.allowNoKey))throw new Error('请配置 CAD 模型服务地址、API Key 和支持建模 JSON 的视觉/对话模型');
  let url;try{url=new URL(config.base.replace(/\/+$/,'')+'/chat/completions');}catch{throw new Error('CAD 模型接口地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('CAD 模型接口地址无效');
  const timeout=Number(config.timeout||180000);if(!Number.isFinite(timeout)||timeout<1||timeout>600000)throw new Error('CAD 模型等待时间无效');
  if(!Array.isArray(references)||references.length>4)throw new Error('CAD 建模最多支持 4 张参考图');
  for(const ref of references)if(!Buffer.isBuffer(ref.bytes)||ref.bytes.length>20*1024*1024||!['image/png','image/jpeg','image/webp'].includes(ref.type))throw new Error('CAD 参考图须为 20 MB 以内的 PNG、JPEG 或 WEBP');
  const text=String(params.additionalPrompt||params.prompt||'').trim();
  if(text.length>12000||!text&&!references.length)throw new Error('请输入 12000 字以内的建模描述，或上传参考图');
  if(params.mode!=='text'&&!references.length)throw new Error('图片建模需要先读取本地参考图');

  const refineRounds=Math.min(2,Math.max(0,Number(config.refineRounds??1)||0));
  const analyze=config.analyze!==false;
  const maxTokens=Math.min(32000,Math.max(2000,Number(config.maxTokens||16000)));
  const usage={promptTokens:0,completionTokens:0,totalTokens:0};
  const isQwen=/(^|\.)aliyuncs\.com$/.test(url.hostname)&&/^qwen/i.test(config.model);

  async function callModel(messages, tokenBudget) {
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
    const options=isQwen?{enable_thinking:false,max_tokens:tokenBudget,response_format:{type:'json_object'}}:{max_tokens:tokenBudget};
    let response;
    try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(config.key?{Authorization:`Bearer ${config.key}`}:{})},body:JSON.stringify({model:config.model,messages,stream:false,...options}),signal:requestSignal});}
    catch(e){throw new Error(requestSignal.aborted?'CAD 模型请求已停止或超时':'CAD 模型连接失败，请检查接口与网络');}
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength>4*1024*1024)throw new Error('CAD 模型响应过大');
    let packet;try{packet=JSON.parse(Buffer.from(bytes).toString());}catch{throw new Error('CAD 模型接口未返回有效 JSON 响应');}
    if(!response.ok||packet.error)throw new Error(`CAD 模型调用失败（HTTP ${response.status}）：${safeProviderMessage(packet.error?.message||packet.message,config.key)||'请检查模型、权限与接口协议'}`);
    if(packet.usage){usage.promptTokens+=packet.usage.prompt_tokens||0;usage.completionTokens+=packet.usage.completion_tokens||0;usage.totalTokens+=packet.usage.total_tokens||0;}
    return packet.choices?.[0]?.message?.content;
  }

  const imageContent=references.flatMap((ref,index)=>[
    {type:'text',text:`参考图 ${index+1}${params.multiViewImages?.[index]?.viewType?'，视角：'+params.multiViewImages[index].viewType:''}`},
    {type:'image_url',image_url:{url:`data:${ref.type};base64,${ref.bytes.toString('base64')}`}},
  ]);
  await mkdir(outputDir,{recursive:true});

  // 阶段一：图片模式先做结构化视觉分析，为建模提供部件/对称/比例依据。
  let plan=null,analysisUsed=false;
  if(references.length&&analyze){
    await onProgress({phase:'analysis',message:'正在分析参考图的部件结构、对称性与比例'});
    try{
      const raw=await callModel([{role:'system',content:buildAnalysisSystemPrompt()},{role:'user',content:[...imageContent,{type:'text',text:buildAnalysisPrompt(text)}]}],1500);
      if(typeof raw==='string')await writeFile(resolve(outputDir,taskId+'-analysis.json'),raw);
      const parsed=tolerantJsonObject(raw);
      const planObject=Array.isArray(parsed)?parsed.find(item=>item&&typeof item==='object'):parsed;
      if(planObject&&Array.isArray(planObject.parts)){plan=planObject;analysisUsed=true;}
    }catch(error){
      if(signal?.aborted)throw error;
      // 分析失败不阻断建模，退化为直接图片建模。
    }
  }

  // 阶段二：建模 + 结构校验纠错（最多 2 次重试）。
  const system=buildJewelrySystemPrompt();
  const userPrompt=references.length?buildJewelryImagePrompt(text,plan):buildJewelryTextPrompt(text);
  const messages=[{role:'system',content:system},{role:'user',content:[...imageContent,{type:'text',text:userPrompt}]}];
  let result=null,correctionAttempts=0;
  for(let attempt=0;attempt<=MAX_CORRECTION_ATTEMPTS;attempt++){
    await onProgress({phase:'model-request',message:attempt?'正在根据结构校验结果修正建模参数':'正在使用 Qwen 生成参数化实体建模结构'});
    const raw=await callModel(messages,maxTokens);
    if(typeof raw==='string')await writeFile(resolve(outputDir,taskId+`-draft-${attempt+1}.json`),raw);
    await onProgress({phase:'geometry',message:'正在校验建模结构并计算实体布尔网格'});
    signal?.throwIfAborted();
    try{
      result=await exportCadModel({raw,outputDir,taskId,providerModel:config.model,appearance:params.generateType||'Normal'});
      correctionAttempts=attempt;
      break;
    }catch(error){
      if(attempt===MAX_CORRECTION_ATTEMPTS||typeof raw!=='string')throw error;
      messages.push({role:'assistant',content:raw},{role:'user',content:'建模校验失败，请保持设计意图并修正以下问题，只输出完整CadModel JSON，不得执行代码或省略结构。\n'+error.message.slice(0,5000)});
    }
  }

  // 阶段三：渲染三视角 → 同一视觉模型自评 → 修正重建。失败降级保留已有结果。
  let refineApplied=0,refineNote='';
  const previewViews=[];
  for(let round=1;round<=refineRounds;round++){
    await onProgress({phase:'preview',message:`正在渲染三视角预览（第 ${round} 轮自评）`});
    const views=await renderPreviews(result.artifacts.STL,outputDir,taskId,round);
    if(!views){refineNote='预览渲染不可用，已跳过自评修正';break;}
    previewViews.push(...views.map(v=>v.path));
    await onProgress({phase:'critique',message:'正在对比参考与渲染结果，自评形体并修正'});
    let critiqueRaw;
    try{
      const renderContent=[];
      for(const v of views){renderContent.push({type:'text',text:`模型渲染图（${v.name} 视角）`},{type:'image_url',image_url:{url:`data:image/png;base64,${(await readFile(v.path)).toString('base64')}`}});}
      critiqueRaw=await callModel([{role:'system',content:system},{role:'user',content:[...imageContent,...renderContent,{type:'text',text:buildCritiquePrompt(text,plan,{hasReference:references.length>0,round})}]}],maxTokens);
    }catch(error){
      if(signal?.aborted)throw error;
      refineNote='自评调用失败，已保留当前模型';break;
    }
    if(typeof critiqueRaw==='string')await writeFile(resolve(outputDir,taskId+`-critique-${round}.json`),critiqueRaw);
    const parsed=tolerantJsonObject(critiqueRaw);
    let verdict=null,salvageModel=null;
    if(Array.isArray(parsed)){
      const nodes=parsed.filter(v=>v&&typeof v==='object'&&typeof v.kind==='string');
      if(nodes.length)salvageModel={units:'mm',model:nodes.length===1?nodes[0]:{kind:'union',children:nodes}};
    }else if(parsed&&typeof parsed==='object'){
      if(parsed.verdict)verdict=parsed;
      else if(parsed.model||typeof parsed.kind==='string')salvageModel=parsed.model?parsed:{units:'mm',model:parsed};
    }
    // 兑底：模型可能跳过 verdict 包装直接返回修正模型。
    if(salvageModel){
      try{
        result=await exportCadModel({raw:salvageModel,outputDir,taskId,providerModel:config.model,appearance:params.generateType||'Normal'});
        refineApplied=round;
      }catch(error){refineNote='自评修正未通过结构校验，已保留修正前模型：'+error.message.slice(0,300);}
      break;
    }
    if(!verdict){refineNote='自评未返回有效结论，已保留当前模型';break;}
    if(verdict.verdict==='ok')break;
    if(verdict.verdict!=='revise'||!verdict.model){refineNote='自评结论无法解析，已保留当前模型';break;}
    const candidate=verdict.model.model?verdict.model:{units:'mm',title:result.metadata.title,model:verdict.model};
    try{
      result=await exportCadModel({raw:candidate,outputDir,taskId,providerModel:config.model,appearance:params.generateType||'Normal'});
      refineApplied=round;
      if(Array.isArray(verdict.issues))result.metadata.refineIssues=verdict.issues.slice(0,8);
    }catch(error){
      refineNote='自评修正未通过结构校验，已保留修正前模型：'+error.message.slice(0,300);
      break;
    }
  }

  result.metadata.usage=usage.totalTokens?usage:null;
  result.metadata.correctionAttempts=correctionAttempts;
  result.metadata.analysisUsed=analysisUsed;
  result.metadata.refineRequested=refineRounds;
  result.metadata.refineApplied=refineApplied;
  if(refineNote)result.metadata.refineNote=refineNote;
  if(previewViews.length)result.metadata.previewRenders=previewViews;
  await onProgress({phase:'exported',message:'已生成真实 GLB、STL、DXF 和可编辑建模 JSON'});
  return result;
}