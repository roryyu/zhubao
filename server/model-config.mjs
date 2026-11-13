import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const visionScript = fileURLToPath(new URL('../../../vision.js', import.meta.url));

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function modelConfig(kind) {
  const prefix = kind === 'image' ? 'IMAGE' : 'CHAT';
  return {
    base: (process.env[`${prefix}_BASE_URL`] || '').replace(/\/+$/, ''),
    key: process.env[`${prefix}_API_KEY`] || '',
    model: process.env[`${prefix}_MODEL`] || '',
    allowNoKey: process.env[`${prefix}_ALLOW_NO_KEY`] === 'true',
    style: process.env.IMAGE_API_STYLE || 'auto',
    helper: process.env[`${prefix}_PROVIDER`] === 'vision-script',
    timeout: Number(process.env[`${prefix}_TIMEOUT_MS`] || (kind === 'image' ? 240000 : 90000)),
  };
}

export function configured(config) {
  return config.helper ? existsSync(visionScript) : Boolean(config.base && config.model && (config.key || config.allowNoKey));
}

export function endpoint(config, route) {
  const url = new URL(config.base + '/' + route);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型接口地址格式不正确');
  return url;
}

export function headers(config) {
  return config.key ? { Authorization: `Bearer ${config.key}` } : {};
}

export function imageProtocol(config) {
  if (config.style !== 'auto') return config.style;
  try {
    const host = new URL(config.base).hostname;
    if (/(^|\.)aliyuncs\.com$/.test(host) && /^qwen-image-2\.0(?:-|$)/i.test(config.model)) return 'dashscope';
  } catch {}
  return 'images';
}

export function imageEndpoint(config, route) {
  if (imageProtocol(config) !== 'dashscope') return endpoint(config, route);
  const url = endpoint(config, '');
  url.pathname = '/api/v1/services/aigc/multimodal-generation/generation';
  url.search = ''; url.hash = '';
  return url;
}

export function capabilities() {
  return Object.fromEntries(['image', 'chat'].map(kind => {
    const c = modelConfig(kind);
    return [kind, { configured: configured(c), model: c.helper ? (kind === 'image' ? process.env.IMAGE_MODEL || 'vision.js 默认图片模型' : process.env.VISION_MODEL || 'vision.js 默认对话模型') : c.model, protocol: c.helper ? 'vision-script' : kind === 'image' ? imageProtocol(c) : 'chat-completions' }];
  }));
}
