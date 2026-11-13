import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportCadModel,parseCadModel,generateCad } from '../server/cad-provider.mjs';
import { expandCadModel } from '../server/cad/dsl.mjs';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hasPython=existsSync(resolve(projectRoot,'.venv-geometry/bin/python'));
const ring={units:'mm',title:'戒圈与主石',summary:'尺寸为测试设定',model:{kind:'union',children:[
 {kind:'torus',size:{radius:10,tube:1},material:{type:'metal',color:'#d4af37'}},
 {kind:'sphere',size:{radius:2},transform:{translate:[0,11,0],scale:[1,1.3,0.7]},material:{type:'glass',color:'#22885a',transmission:0.5}},
]}};
const root=await mkdtemp(resolve(tmpdir(),'cjzb-cad-'));

async function readGlbBounds(path){
 const bytes=await readFile(path);
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 let meshes=0,minY=Infinity,maxSpan=0;
 gltf.scene.traverse(x=>{if(x.isMesh){meshes++;x.geometry.computeBoundingBox();const b=x.geometry.boundingBox;minY=Math.min(minY,b.min.y);maxSpan=Math.max(maxSpan,b.max.x-b.min.x,b.max.y-b.min.y,b.max.z-b.min.z);}});
 return {meshes,minY,maxSpan};
}

try{
 await test('用户项目的参数化建模生成真实 GLB/STL/DXF/JSON',async()=>{
  const result=await exportCadModel({raw:ring,outputDir:root,taskId:'local-ring'});
  assert.ok(result.metadata.triangleCount>100);assert.equal(result.metadata.manufacturingValidated,false);
  const glb=await readFile(result.artifacts.GLB),stl=await readFile(result.artifacts.STL),dxf=await readFile(result.artifacts.DXF,'utf8');
  assert.equal(glb.toString('ascii',0,4),'glTF');assert.equal(glb.readUInt32LE(8),glb.length);
  const {meshes,maxSpan}=await readGlbBounds(result.artifacts.GLB);
  assert.ok(meshes>0);assert.ok(maxSpan<0.1);assert.ok(maxSpan>0.01);
  assert.equal(stl.length,84+50*stl.readUInt32LE(80));assert.ok(stl.readUInt32LE(80)>100);
  assert.ok(dxf.includes('3DFACE'));assert.ok(dxf.includes('$INSUNITS'));assert.equal(JSON.parse(await readFile(result.artifacts.JSON,'utf8')).units,'mm');
 });
 await test('拒绝代码、非法参数、错误单位和过大模型',()=>{
  assert.throws(()=>parseCadModel('function(){ return 1 }'));
  assert.throws(()=>parseCadModel(JSON.stringify({...ring,units:'m'})));
  assert.throws(()=>parseCadModel(JSON.stringify({units:'mm',model:{kind:'torus',size:{radius:0,tube:1}}})));
  assert.throws(()=>parseCadModel(JSON.stringify({units:'mm',model:{kind:'torus',size:{radius:10,tube:1},transform:{scale:[1e12,1,1]}}})));
 });
 await test('归一化裸节点数组与裸节点输出',async()=>{
  const bareArray=[{kind:'torus',size:{radius:10,tube:1}},{kind:'sphere',size:{radius:2},transform:{translate:[0,11,0]}}];
  const a=await exportCadModel({raw:bareArray,outputDir:root,taskId:'bare-array'});
  assert.ok(a.metadata.triangleCount>100);assert.equal(a.metadata.expandedInstances,2);
  const bareNode={kind:'sphere',size:{radius:5}};
  const b=await exportCadModel({raw:bareNode,outputDir:root,taskId:'bare-node'});
  assert.ok(b.metadata.triangleCount>100);
 });
 await test('扩展图元 lathe/extrude/tube/capsule/roundedBox 导出真实网格并落地',async()=>{
  const model={units:'mm',title:'扩展图元',model:{kind:'union',children:[
   {kind:'lathe',profile:[[0,-3],[3,0],[3,0.3],[1.6,1.5],[0,1.5]],transform:{translate:[0,3,0]}},
   {kind:'extrude',outline:[[0,4],[3,-2],[-3,-2]],depth:1.5,bevel:0.3,transform:{translate:[10,0,0]}},
   {kind:'tube',path:[[0,0,0],[4,2,0],[8,0,0]],size:{radius:0.6},transform:{translate:[-10,0,0]}},
   {kind:'capsule',size:{radius:1,length:4},transform:{translate:[0,0,8]}},
   {kind:'roundedBox',size:{w:4,h:2,d:3,radius:0.5},transform:{translate:[0,0,-8]}},
  ]}};
  const result=await exportCadModel({raw:model,outputDir:root,taskId:'extended'});
  assert.ok(result.metadata.triangleCount>500);
  const {meshes,minY,maxSpan}=await readGlbBounds(result.artifacts.GLB);
  assert.ok(meshes>0);assert.ok(Math.abs(minY)<1e-6,'模型应落地 y=0');assert.ok(maxSpan>0.01&&maxSpan<0.1);
 });
 await test('mirror/array 展开为对称副本，预算超限被拒绝',async()=>{
  const sym={units:'mm',model:{kind:'array',mode:'radial',axis:'y',count:6,child:{kind:'capsule',size:{radius:0.5,length:2},transform:{translate:[3,0,0]}}}};
  const {model}=parseCadModel(JSON.stringify(sym));
  const {root:expanded,instances}=expandCadModel(model);
  assert.equal(instances,6);assert.equal(expanded.kind,'union');assert.equal(expanded.children.length,6);
  const result=await exportCadModel({raw:sym,outputDir:root,taskId:'array'});
  assert.equal(result.metadata.expandedInstances,6);
  const glb=await readFile(result.artifacts.GLB);
  const gltf=await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
  gltf.scene.traverse(x=>{if(x.isMesh){x.geometry.computeBoundingBox();const b=x.geometry.boundingBox;assert.ok(Math.abs(b.max.x+b.min.x)<0.001,'径向阵列应关于原点对称');}});
  assert.throws(()=>parseCadModel(JSON.stringify({units:'mm',model:{kind:'array',count:65,child:{kind:'sphere',size:{radius:1}}}})));
  assert.throws(()=>parseCadModel(JSON.stringify({units:'mm',model:{kind:'lathe',profile:[[1,0]]}})));
  assert.throws(()=>parseCadModel(JSON.stringify({units:'mm',model:{kind:'sphere',size:{radius:1},transform:{scale:[-1,1,1]}}})));
  const mirror={units:'mm',model:{kind:'mirror',axis:'x',child:{kind:'sphere',size:{radius:1},transform:{translate:[3,0,0]}}}};
  const m=await exportCadModel({raw:mirror,outputDir:root,taskId:'mirror'});
  assert.equal(m.metadata.expandedInstances,2);
 });
 await test('真实模型协议传入参考图，不执行模型代码，不泄露 Key',async()=>{
  let mode='ok',seen;
  const provider=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);seen=JSON.parse(Buffer.concat(parts));res.setHeader('Content-Type','application/json');if(mode==='error'){res.writeHead(400).end(JSON.stringify({error:{message:'cad-test-key is not valid'}}));}else res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(ring)}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const config={base:`http://127.0.0.1:${provider.address().port}/v1`,key:'cad-test-key',model:'test-cad',analyze:false,refineRounds:0};
  try{
   const result=await generateCad({params:{mode:'image',additionalPrompt:'绿色宝石戒指'},references:[{bytes:Buffer.from('test image data'),type:'image/png'}],config,outputDir:root,taskId:'provider-ring'});
   assert.ok(result.modelPath.endsWith('.glb'));assert.ok(seen.messages[1].content.find(c=>c.image_url)?.image_url.url.startsWith('data:image/png;base64,'));assert.equal(seen.model,'test-cad');
   mode='error';await assert.rejects(generateCad({params:{mode:'text',additionalPrompt:'戒指'},config,outputDir:root,taskId:'rejected'}),error=>!error.message.includes('cad-test-key')&&error.message.includes('400'));
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 });
 await test('结构校验失败最多修正两次；白模导出正确',async()=>{
  let calls=0,alwaysBad=false,requests=[];
  const provider=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);requests.push(JSON.parse(Buffer.concat(parts)));calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:alwaysBad||calls===1?'{}':JSON.stringify(ring)}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const config={base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-cad',allowNoKey:true,analyze:false,refineRounds:0};
  try{
   const result=await generateCad({params:{mode:'text',additionalPrompt:'18mm 黄金戒指',generateType:'Geometry'},config,outputDir:root,taskId:'corrected'});
   assert.equal(calls,2);assert.equal(result.metadata.correctionAttempts,1);assert.equal(requests[1].messages.length,4);
   const b=await readFile(result.artifacts.GLB);const json=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
   assert.ok(json.materials.every(m=>m.pbrMetallicRoughness.metallicFactor===0));assert.equal(result.metadata.appearance,'Geometry');
   alwaysBad=true;calls=0;requests=[];await assert.rejects(generateCad({params:{mode:'text',additionalPrompt:'戒指'},config,outputDir:root,taskId:'still-invalid'}));assert.equal(calls,3);
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 });
 await test('图片模式先结构分析再建模，分析失败降级不阻断',async()=>{
  let calls=0,requests=[];
  const provider=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));requests.push(body);calls++;res.setHeader('Content-Type','application/json');
   const isAnalysis=body.messages[0].content.includes('结构分析师');
   res.end(JSON.stringify({choices:[{message:{content:isAnalysis?JSON.stringify({object:'戒指',parts:[{name:'戒圈',primitive:'lathe'}]}):JSON.stringify(ring)}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const config={base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-cad',allowNoKey:true,refineRounds:0};
  try{
   const result=await generateCad({params:{mode:'image',additionalPrompt:'戒指'},references:[{bytes:Buffer.from('img'),type:'image/png'}],config,outputDir:root,taskId:'analyzed'});
   assert.equal(calls,2);assert.equal(result.metadata.analysisUsed,true);
   assert.ok(requests[1].messages[1].content.some(c=>c.type==='text'&&c.text.includes('结构分析')));
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 });
 await test('渲染自评闭环：revise 后采用修正模型',async t=>{
  if(!hasPython)return t.skip('缺少 geometry venv，跳过自评闭环');
  let calls=0;
  const wide={...ring,title:'过宽戒指',model:{kind:'torus',size:{radius:10,tube:4},material:{type:'metal',color:'#d4af37'}}};
  const provider=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));calls++;res.setHeader('Content-Type','application/json');
   const isCritique=body.messages[1].content.some(c=>c.type==='text'&&c.text.includes('形体自评'));
   const content=isCritique?JSON.stringify({verdict:'revise',issues:['戒圈过宽'],model:ring}):JSON.stringify(wide);
   res.end(JSON.stringify({choices:[{message:{content}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const config={base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-cad',allowNoKey:true,analyze:false,refineRounds:1};
  try{
   const result=await generateCad({params:{mode:'text',additionalPrompt:'戒指'},config,outputDir:root,taskId:'refined'});
   assert.equal(calls,2);assert.equal(result.metadata.refineApplied,1);
   assert.deepEqual(result.metadata.refineIssues,['戒圈过宽']);
   assert.equal(result.metadata.title,'戒圈与主石');
   assert.ok(result.metadata.previewRenders.length>=3);
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 });
 await test('自评兑底：模型直接返回修正模型（无 verdict 包装）也采用',async t=>{
  if(!hasPython)return t.skip('缺少 geometry venv');
  const wide={...ring,title:'过宽',model:{kind:'torus',size:{radius:10,tube:4}}};
  const provider=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));res.setHeader('Content-Type','application/json');
   const isCritique=body.messages[1].content.some(c=>c.type==='text'&&c.text.includes('形体自评'));
   res.end(JSON.stringify({choices:[{message:{content:isCritique?JSON.stringify(ring):JSON.stringify(wide)}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const config={base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-cad',allowNoKey:true,analyze:false,refineRounds:1};
  try{
   const result=await generateCad({params:{mode:'text',additionalPrompt:'戒指'},config,outputDir:root,taskId:'salvage'});
   assert.equal(result.metadata.refineApplied,1);assert.equal(result.metadata.title,'戒圈与主石');
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 });
}finally{await rm(root,{recursive:true,force:true});}