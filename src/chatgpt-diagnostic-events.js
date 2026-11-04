import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHATGPT_EVENTS_DIR = path.join(os.homedir(), '.chat-vault', 'diagnostics');

export function appendChatgptDiagnosticEvent(event, dir = CHATGPT_EVENTS_DIR) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.event !== 'string' || !event.event.trim()) {
    throw new Error('诊断事件缺少 event 名称');
  }
  const receivedAt = new Date().toISOString();
  const file = path.join(dir, `chatgpt-events-${receivedAt.slice(0, 10)}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ...event, received_at: receivedAt }) + '\n', 'utf8');
  return { file, received_at: receivedAt };
}
