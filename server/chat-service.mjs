import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelConfig, configured, endpoint, headers, visionScript } from './model-config.mjs';
import { conversations, answers, createConversation } from './chat-store.mjs';

const active = new Map();
const execFileAsync = promisify(execFile);
export function stopChat(id) { active.get(String(id))?.abort(); }

export async function streamChat(body, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = data => { if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n'); };
  const fail = msg => emit({ error: true, code: 50101, msg });
  const config = modelConfig('chat');
  if (!configured(config)) { fail('请先在项目 .env 配置 CHAT_BASE_URL、CHAT_API_KEY 和 CHAT_MODEL，再重启服务。'); res.end(); return; }
  if (typeof body?.msg !== 'string' || !body.msg.trim() || body.msg.length > 100000) { fail('请输入有效的对话内容'); res.end(); return; }
  const images = body.images || [];
  if (!Array.isArray(images) || images.length > 4 || images.some(i => typeof i !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(i))) { fail('对话图片仅支持最多 4 张 PNG、JPEG 或 WEBP'); res.end(); return; }
  if (images.length && process.env.CHAT_VISION !== 'true') { fail('当前对话模型未启用识图，请使用支持识图的模型并设置 CHAT_VISION=true'); res.end(); return; }
  let window = conversations.get(String(body.windowId));
  if (!window) window = createConversation(body.modelId);
  if (active.has(window.id)) { fail('此对话正在生成，请等待完成'); res.end(); return; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), config.timeout);
  const closed = () => controller.abort();
  res.on('close', closed); active.set(window.id, controller);
  try {
    const presets = JSON.parse(readFileSync(new URL('./public-content.json', import.meta.url), 'utf8')).models;
    const preset = presets.find(m => String(m.id) === String(window.modeId));
    const system = process.env.CHAT_SYSTEM_PROMPT || '你是珠宝设计助手。帮助用户推敲造型、材质、宝石镶嵌和加工约束。区分视觉概念与可生产工程，未知尺寸、重量和工艺条件需要向用户确认，不编造检测或制造结果。';
    const history = (answers.get(window.id) || []).slice(-20);
    const messages = [{ role: 'system', content: system + (preset ? `\n当前场景：${preset.modelTitle}。${preset.modelCall || ''}` : '') }];
    for (const item of history) {
      if (item.question) messages.push({ role: 'user', content: item.questionContent || item.question });
      if (item.answer) messages.push({ role: 'assistant', content: item.answer });
    }
    const questionContent = images.length ? [{ type: 'text', text: body.msg }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : body.msg;
    messages.push({ role: 'user', content: questionContent });
    const temperature = Number(body.answerTemperature);
    const sampling = process.env.CHAT_SEND_TEMPERATURE !== 'false' && body.answerTemperature != null && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? { temperature } : {};
    let response;
    if (config.helper) {
      try {
        const invocation = execFileAsync(process.execPath, [visionScript, '--chat-json'], { signal: controller.signal, maxBuffer: 8 * 1024 * 1024 });
        invocation.child.stdin.on('error', () => {});
        invocation.child.stdin.end(JSON.stringify({ messages, ...sampling }));
        const { stdout } = await invocation;
        response = new Response(stdout, { headers: { 'Content-Type': 'application/json' } });
      } catch { throw new Error('对话模型调用失败，请检查 vision.js 的服务商额度、模型权限或网络'); }
    } else response = await fetch(endpoint(config, 'chat/completions'), { method: 'POST', headers: { ...headers(config), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, messages, stream: true, ...sampling }), signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`对话模型调用失败（HTTP ${response.status}），请检查接口、模型、Key 或额度。`); }
    const id = randomUUID(); let answer = '', completed = false, usage = null;
    emit({ windowId: window.id, questionAnswerId: id });
    const accept = packet => {
      if (packet.error) throw new Error('对话模型返回错误，请在服务商控制台检查调用状态');
      const content = packet.choices?.[0]?.delta?.content;
      if (typeof content === 'string') { answer += content; emit({ msg: content }); }
      if (packet.usage) usage = packet.usage;
      if (answer.length > 4 * 1024 * 1024) throw new Error('对话输出过长，已停止接收');
    };
    if (response.headers.get('content-type')?.includes('application/json')) {
      const packet = await response.json();
      const content = packet.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('对话模型响应格式不支持');
      answer = content; usage = packet.usage; completed = true; emit({ msg: content });
    } else {
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { completed = true; break; }
          if (data) { let packet; try { packet = JSON.parse(data); } catch { throw new Error('对话模型返回了无效的流式数据'); } accept(packet); }
        }
        if (completed) break;
      }
    }
    if (!completed) throw new Error('对话输出中断，请重试');
    if (!answer.trim()) throw new Error('对话模型没有返回文字内容');
    const tokens = { quesTokens: usage?.prompt_tokens || 0, ansTokens: usage?.completion_tokens || 0, allTokens: usage?.total_tokens || 0 };
    answers.set(window.id, [...(answers.get(window.id) || []), { id, question: body.msg, questionContent, answer, ...tokens, attachments: body.attachments, createDate: new Date().toISOString() }]);
    window.title = window.windowName = body.msg.slice(0, 24);
    window.questionCount = answers.get(window.id).length;
    if (usage) emit({ type: 'tokenInfo', promptTokens: tokens.quesTokens, completionTokens: tokens.ansTokens, totalTokens: tokens.allTokens });
    emit({ isDone: true, windowId: window.id, questionAnswerId: id });
  } catch (e) {
    fail(controller.signal.aborted ? '对话已停止或请求超时' : /^(对话|模型)/.test(e.message) ? e.message : '对话连接失败，请检查模型接口地址和网络');
  } finally {
    clearTimeout(timer); res.off('close', closed); active.delete(window.id); res.end();
  }
}
