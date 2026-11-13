import { spawn } from 'node:child_process';
import { existsSync,createWriteStream } from 'node:fs';
import { mkdir,rename,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const python=resolve(root,'.venv-geometry',process.platform==='win32'?'Scripts/python.exe':'bin/python');
function run(program,args){return new Promise((resolve,reject)=>{const process=spawn(program,args,{cwd:root,stdio:'inherit'});process.on('error',reject);process.on('exit',code=>code===0?resolve():reject(new Error('Geometry setup failed: '+code)));});}
if(!existsSync(python))await run('python3',['-m','venv','.venv-geometry']);
await run(python,['-m','pip','install','-r','requirements-geometry.txt']);
const folder=resolve(root,'data/models'),path=resolve(folder,'depth-anything-v2-small.onnx');
await mkdir(folder,{recursive:true});
const source='https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx';
if(!existsSync(path)){
 console.log('Downloading Depth Anything V2 Small ONNX...');
 const response=await fetch(source);if(!response.ok)throw new Error('Depth model download failed: '+response.status);
 await pipeline(Readable.fromWeb(response.body),createWriteStream(path+'.partial'));await rename(path+'.partial',path);
}
await run(python,['-c',"import onnxruntime as o; o.InferenceSession('data/models/depth-anything-v2-small.onnx',providers=['CPUExecutionProvider']); print('Depth model loaded')"]);
const bytes=await readFile(path);
await writeFile(resolve(folder,'depth-anything-v2-small.manifest.json'),JSON.stringify({source,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},null,2));
console.log('Local relief engine is ready.');
