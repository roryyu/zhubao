import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createDesignService } from '../server/image-service.mjs';
import { streamChat } from '../server/chat-service.mjs';
import { capabilities, imageProtocol } from '../server/model-config.mjs';
import { answers, conversations } from '../server/chat-store.mjs';
import { handleLocalApi } from '../server/fixtures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const project = resolve(import.meta.dirname, '..');
const query = new URLSearchParams();
let upstreamMode = 'image', observed = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  observed.push({ url: req.url, body: text, auth: req.headers.authorization, type: req.headers['content-type'] });
  if (upstreamMode === 'native') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,' + png.toString('base64') }] } }] } })); return; }
  if (upstreamMode === 'reject-detail') { res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'invalid size; provider-secret-test-key; Bearer abc123; https://provider.example/path?signature=private'}})); return; }
  if (upstreamMode === 'reject') { res.writeHead(401).end('provider-secret-test-key'); return; }
  if (upstreamMode === 'invalid') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] })); return; }
  if (upstreamMode === 'chat' || upstreamMode === 'truncated') {
    res.setHeader('content-type', 'text/event-stream');
    const content = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '镶爪建议' } }] }) + '\n\n';
    const bytes = Buffer.from(content);
    res.write(bytes.subarray(0, 60));
    setImmediate(() => {
      res.write(bytes.subarray(60));
      res.end(upstreamMode === 'chat' ? 'data: [DONE]\n\n' : '');
    });
    return;
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
Object.assign(process.env, { IMAGE_PROVIDER: '', IMAGE_BASE_URL: base, IMAGE_API_KEY: 'provider-secret-test-key', IMAGE_MODEL: 'test-image', IMAGE_API_STYLE: 'images', IMAGE_SIZE: '', CHAT_PROVIDER: '', CHAT_BASE_URL: base, CHAT_API_KEY: 'provider-secret-test-key', CHAT_MODEL: 'test-chat' });
const root = await mkdtemp(resolve(tmpdir(), 'cjzb-model-test-'));
await mkdir(resolve(root, 'data/uploads'), { recursive: true });
await writeFile(resolve(root, 'data/uploads/reference.png'), png);
let designs = createDesignService(root); await designs.ready;
const origin = 'http://127.0.0.1:4174';
const call = (pathname, method = 'GET', body, search = query) => designs.handle({ pathname, method, body, query: search, origin });
async function finish(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { data } = await call('/api/draw/comfyuiTask/' + id);
    if ([6,8].includes(data.status)) return data;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error('Test task timeout');
}
try {
  await test('模型接口协议（本地模拟）：生成、保存、历史与重启恢复', async () => {
    const response = await call('/api/unified/submit-task', 'POST', { appNumber: 2000, params: { additionalPrompt: '黄金戒指' } });
    assert.equal(response.code, 0);
    const task = await finish(response.data.task_id);
    assert.equal(task.status, 8);
    assert.deepEqual(await readFile(resolve(root, 'data', new URL(task.output).pathname.slice(1))), png);
    assert.equal(observed.at(-1).url, '/v1/images/generations');
    assert.ok(JSON.parse(observed.at(-1).body).prompt.includes('黄金戒指'));
    const history = await call('/api/draw/comfyuiTask/page'); assert.equal(history.data.total, 1);
    designs = createDesignService(root); await designs.ready;
    assert.equal((await call('/api/draw/comfyuiTask/' + task.id)).data.status, 8);
  });
  await test('参考图作为图片文件传给编辑模型', async () => {
    const response = await call('/api/unified/submit-task', 'POST', { appNumber: 2003, params: { additionalPrompt: '保留主石，设计黄金托架', image: [origin + '/uploads/reference.png'] } });
    assert.equal((await finish(response.data.task_id)).status, 8);
    const sent = observed.at(-1);
    assert.equal(sent.url, '/v1/images/edits'); assert.ok(sent.type.startsWith('multipart/form-data'));
    assert.ok(sent.body.includes('reference-0.png')); assert.ok(sent.body.includes('保留主石'));
    const rejected = await call('/api/unified/submit-task', 'POST', { appNumber: 2003, params: { image: ['https://unrelated.example/private.png'] } });
    assert.notEqual(rejected.code, 0);
  });
  await test('DashScope 原生文生图和编辑：路径、图片输入、星号尺寸和结果读取', async () => {
    process.env.IMAGE_API_STYLE = 'dashscope'; process.env.IMAGE_SIZE = '2048x2048'; upstreamMode = 'native';
    try {
      for (const refs of [[], [origin + '/uploads/reference.png']]) {
        const response = await call('/api/unified/submit-task', 'POST', {appNumber: refs.length ? 2003 : 2000, params: {additionalPrompt:'镶嵌首饰', image:refs}});
        assert.equal((await finish(response.data.task_id)).status,8);
        const sent=observed.at(-1), packet=JSON.parse(sent.body);
        assert.equal(sent.url,'/api/v1/services/aigc/multimodal-generation/generation');
        assert.equal(sent.auth,'Bearer provider-secret-test-key');
        assert.equal(packet.parameters.size,'2048*2048');
        assert.equal(packet.input.messages[0].content.filter(x=>x.image).length,refs.length);
        assert.equal(packet.input.messages[0].content.filter(x=>x.text).length,1);
        assert.equal(packet.size,undefined);
      }
      assert.equal(imageProtocol({style:'auto',base:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',model:'qwen-image-2.0'}),'dashscope');
      assert.equal(imageProtocol({style:'auto',base:'https://other.example/v1',model:'other-image'}),'images');
    } finally { process.env.IMAGE_API_STYLE = 'images'; process.env.IMAGE_SIZE = ''; }
  });
  await test('保留参数错误详情，同时去除 Key、Bearer 和签名 URL', async () => {
    upstreamMode='reject-detail';
    const response=await call('/api/unified/submit-task','POST',{appNumber:2000,params:{additionalPrompt:'戒指'}});
    const task=await finish(response.data.task_id);
    assert.equal(task.status,6); assert.ok(task.errorMsg.includes('invalid size'));
    assert.ok(!task.errorMsg.includes('provider-secret-test-key')); assert.ok(!task.errorMsg.includes('abc123')); assert.ok(!task.errorMsg.includes('signature=private'));
  });
  await test('模型失败不返回成功图片，不泄露上游错误内容', async () => {
    upstreamMode = 'reject';
    const response = await call('/api/unified/submit-task', 'POST', { appNumber: 2000, params: { additionalPrompt: '戒指' } });
    const task = await finish(response.data.task_id);
    assert.equal(task.status, 6); assert.equal(task.output, null); assert.ok(!JSON.stringify(task).includes('provider-secret-test-key'));
    upstreamMode = 'invalid';
    const invalid = await call('/api/unified/submit-task', 'POST', { appNumber: 2000, params: { additionalPrompt: '戒指' } });
    assert.equal((await finish(invalid.data.task_id)).status, 6);
    assert.notEqual((await call('/api/unified/submit-task', 'POST', { appNumber: 2011, params: {} })).code, 0);
    assert.ok(!JSON.stringify(capabilities()).includes('provider-secret-test-key'));
  });
  const chatServer = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    await streamChat(JSON.parse(Buffer.concat(chunks).toString()), res);
  });
  chatServer.listen(0, '127.0.0.1'); await once(chatServer, 'listening');
  const chatUrl = `http://127.0.0.1:${chatServer.address().port}`;
  const chat = async body => (await fetch(chatUrl, { method: 'POST', body: JSON.stringify(body) })).text();
  try {
    await test('中文流式回复、多轮上下文与会话隔离', async () => {
      upstreamMode = 'chat';
      const stream = await chat({ msg: '如何设计镶爪', windowId: 0 });
      assert.ok(stream.includes('镶爪建议')); assert.ok(stream.includes('"isDone":true'));
      const windowId = JSON.parse(stream.split('\n').find(x => x.includes('windowId')).slice(6)).windowId;
      assert.equal(answers.get(windowId).length, 1); assert.ok(conversations.has(windowId));
      await chat({ msg: '戒肩呢', windowId });
      const sent = JSON.parse(observed.at(-1).body);
      assert.equal(sent.messages[1].content, '如何设计镶爪'); assert.equal(sent.messages[2].content, '镶爪建议');
      assert.equal(answers.get(windowId).length, 2);
    });
    await test('流中断与未配置不会伪造回复', async () => {
      upstreamMode = 'truncated';
      const stream = await chat({ msg: '中断测试' }); assert.ok(stream.includes('"error":true')); assert.ok(!stream.includes('"isDone":true'));
      process.env.CHAT_MODEL = '';
      const count = observed.length;
      assert.ok((await chat({ msg: '未配置测试' })).includes('CHAT_MODEL')); assert.equal(observed.length, count);
    });
    await test('复制、编辑和删除消息不会修改另一会话', async () => {
      const original = [...conversations.values()].find(w => answers.get(w.id)?.length === 2);
      const invoke = (pathname, method, body) => handleLocalApi({ pathname, method, body, query, origin });
      await invoke('/api/questionWindowNew/copy/' + original.id, 'POST', {});
      const copy = [...conversations.values()].find(w => w.isDefault);
      assert.notEqual(copy.id, original.id);
      const record = answers.get(copy.id)[0];
      assert.notEqual(record.id, answers.get(original.id)[0].id);
      assert.equal((await invoke('/api/questionAnswer/update', 'PUT', { id: record.id, type: 0, msg: '修改后的设计需求' })).code, 0);
      assert.equal(answers.get(original.id)[0].question, '如何设计镶爪');
      assert.equal(answers.get(copy.id)[0].questionContent, '修改后的设计需求');
      await invoke('/api/questionAnswer/delete', 'DELETE', { id: record.id, type: 1 });
      assert.equal(answers.get(copy.id)[0].answer, '');
      assert.equal(answers.get(original.id)[0].answer, '镶爪建议');
    });
  } finally { chatServer.closeAllConnections(); await new Promise(r => chatServer.close(r)); }
} finally {
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
