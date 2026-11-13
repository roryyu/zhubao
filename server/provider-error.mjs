export async function imageProviderError(response, config) {
  // Read only a bounded error object; never retain raw provider bodies.
  const reader = response.body?.getReader();
  let bytes = 0; const chunks = [];
  if (reader) {
    try {
      while (bytes < 8192) {
        const { done, value } = await reader.read(); if (done) break;
        const chunk = value.subarray(0, 8192 - bytes); chunks.push(chunk); bytes += chunk.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let packet; try { packet = JSON.parse(text); } catch {}
  const value = packet?.error?.message || packet?.message || packet?.msg;
  let detail = typeof value === 'string' ? value : '';
  if (config.key) detail = detail.replaceAll(config.key, '[REDACTED]');
  detail = detail.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]')
    .replace(/data:image\/[^\s"'<>]+/gi, '[IMAGE]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
    .replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
  const prefix = response.status === 429 ? '模型服务额度不足或请求过于频繁' : '图片模型调用失败';
  return new Error(`${prefix}（HTTP ${response.status}）${detail ? '：' + detail : '，请检查接口地址、模型权限和请求协议'}`);
}
