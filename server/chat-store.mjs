import { randomUUID } from 'node:crypto';
export const conversations = new Map();
export const answers = new Map();
export function createConversation(modeId = null) {
  for (const item of conversations.values()) item.isDefault = false;
  const id = 'local-' + randomUUID();
  const item = { id, modeId, title: '本地新对话', windowName: '本地新对话', isDefault: true, createDate: new Date().toISOString() };
  conversations.set(id, item);
  return item;
}
