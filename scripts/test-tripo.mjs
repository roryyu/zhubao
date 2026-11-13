import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateTripo, buildTripoRequest, validateGlb, isPublicImageUrl } from '../server/tripo-service.mjs';

function triangleGlb() {
  const binary = Buffer.alloc(36); [0,0,0,1,0,0,0,1,0].forEach((n,i)=>binary.writeFloatLE(n,i*4));
  let json=Buffer.from(JSON.stringify({asset:{version:'2.0'},buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}]}));
  json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+8+binary.length,8);header.writeUInt32LE(json.length,12);header.write('JSON',16);
  const chunk=Buffer.alloc(8);chunk.writeUInt32LE(binary.length);chunk.write('BIN\0',4);
  return Buffer.concat([header,json,chunk,binary]);
}
const glb=triangleGlb(), requests=[]; let mode='success', count=0;
const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const p of req)parts.push(p);
  requests.push({path:req.url,headers:req.headers,body:Buffer.concat(parts).toString()});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/model.glb?signature=private'){res.setHeader('Content-Type','model/gltf-binary');res.end(glb);return;}
  if(req.method==='POST'){
    if(mode==='reject'){res.writeHead(403).end(JSON.stringify({message:'Denied sk-secret https://secret.example/?signature=private'}));return;}
    res.end(JSON.stringify({output:{task_id:'remote-123',task_status:'PENDING'}}));return;
  }
  if(mode==='failed'){res.end(JSON.stringify({output:{task_status:'FAILED',message:'invalid geometry sk-secret'}}));return;}
  if(mode==='unknown'){res.end(JSON.stringify({output:{task_status:'UNKNOWN'}}));return;}
  if(mode==='pending'||count++===0){res.end(JSON.stringify({output:{task_status:'RUNNING'}}));return;}
  res.end(JSON.stringify({output:{task_status:'SUCCEEDED',results:[{model_url:`http://127.0.0.1:${server.address().port}/model.glb?signature=private`}]}}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const dir=await mkdtemp(resolve(tmpdir(),'tripo-test-'));
const config={base:`http://127.0.0.1:${server.address().port}/compatible-mode/v1`,key:'sk-secret',model:'Tripo/Tripo-P1.0',initialPollMs:0,pollIntervalMs:0,timeout:3000};
try{
  await test('Tripo 文本、单图、多图参数与面数边界',async()=>{
    const text=await buildTripoRequest({params:{mode:'text',additionalPrompt:'首饰',faceCount:1000,generateType:'Geometry'},config});
    assert.deepEqual(text.body.input,{prompt:'首饰'});assert.equal(text.body.parameters.texture,false);assert.equal(text.body.parameters.pbr,false);
    const multi=await buildTripoRequest({params:{mode:'multiview',multiViewImages:[{viewType:'back',viewImageUrl:'https://example.com/back.png'},{viewType:'front',viewImageUrl:'https://example.com/front.png'}]},config});
    assert.equal(multi.body.input.images.length,4);assert.ok(multi.body.input.images[0].file_token.endsWith('front.png'));assert.deepEqual(multi.body.input.images[1],{});assert.ok(multi.body.input.images[2].file_token.endsWith('back.png'));
    await assert.rejects(buildTripoRequest({params:{mode:'text',additionalPrompt:'首饰',faceCount:50000},config}),/面数/);
  });
  await test('本地参考图无公开或临时上传配置时不提交付费任务',async()=>{
    const before=requests.length;
    await assert.rejects(generateTripo({params:{mode:'image',imageUrl:'http://127.0.0.1:4174/uploads/a.png'},references:[{bytes:Buffer.alloc(20),type:'image/png'}],config,outputDir:dir,taskId:'local-ref'}),/公网参考图/);
    assert.equal(requests.length,before);
    assert.equal(isPublicImageUrl('http://127.0.0.1/a.png'),false);assert.equal(isPublicImageUrl('https://example.com/a.png'),true);
  });
  await test('创建、持久化回调、轮询和 GLB 下载不向 CDN 发送 Key',async()=>{
    const progress=[];mode='success';count=0;
    const output=await generateTripo({params:{mode:'text',additionalPrompt:'戒指'},config,outputDir:dir,taskId:'success',onProgress:async p=>progress.push(p)});
    assert.equal(progress[0].phase,'submitted');assert.equal(progress[0].remoteTaskId,'remote-123');
    assert.deepEqual(await readFile(output.modelPath),glb);assert.equal(output.metadata.meshes,1);
    const post=requests.find(r=>r.method==='POST'||r.path.includes('3d-generation'));
    assert.equal(post.headers['x-dashscope-async'],'enable');
    assert.equal(requests.find(r=>r.path.startsWith('/model.glb')).headers.authorization,undefined);
    assert.ok(!JSON.stringify(output).includes('signature=private'));
  });
  await test('恢复远程 ID 时只轮询，不重复创建',async()=>{
    const before=requests.filter(r=>r.path.includes('3d-generation')).length;count=1;
    await generateTripo({params:{},config:{...config,remoteTaskId:'remote-123'},outputDir:dir,taskId:'resumed'});
    assert.equal(requests.filter(r=>r.path.includes('3d-generation')).length,before);
  });
  await test('任务失败、过期和中止保留远程 ID',async()=>{
    for(const state of ['failed','unknown']){mode=state;await assert.rejects(generateTripo({params:{},config:{...config,remoteTaskId:'remote-123'},outputDir:dir,taskId:state}),e=>e.remoteTaskId==='remote-123'&&!e.message.includes('sk-secret'));}
    mode='pending';
    await assert.rejects(generateTripo({params:{},config:{...config,remoteTaskId:'remote-123',timeout:30},outputDir:dir,taskId:'timeout'}),e=>e.code==='TRIPO_WAIT_ABORTED'&&e.remoteTaskId==='remote-123');
    mode='reject';await assert.rejects(generateTripo({params:{mode:'text',additionalPrompt:'ring'},config,outputDir:dir,taskId:'rejected'}),e=>e.message.includes('403')&&!e.message.includes('sk-secret')&&!e.message.includes('signature=private'));
  });
  await test('不接受空文件、伪 GLB 或长度不完整的模型',()=>{
    assert.equal(validateGlb(glb).meshes,1);
    assert.throws(()=>validateGlb(Buffer.from('not-glb')),/GLB/);
    assert.throws(()=>validateGlb(glb.subarray(0,glb.length-1)),/GLB/);
  });
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
