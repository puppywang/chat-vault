// 对话内图片落盘存储：~/.agent-exporter/images/<agent>-<sessionId>/<key>.<ext>
// db 只存相对路径，base64 原文不进库。写入幂等（同 key 覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './log.js';

export function imagesDir() {
  return path.join(os.homedir(), '.chat-vault', 'images');
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
};

/**
 * 保存一组图片，返回相对路径数组（用于 messages.images 列）。
 * items: [{data: base64 或 dataURI, mime}]；keyPrefix 用于命名（如 "12" 表示 seq=12）
 */
export function saveImages(agent, agentSessionId, keyPrefix, items) {
  if (!items?.length) return [];
  const dir = path.join(imagesDir(), `${agent}-${sanitize(agentSessionId)}`);
  fs.mkdirSync(dir, { recursive: true });
  const relPaths = [];
  items.forEach((item, i) => {
    if (!item?.data) return;
    let data = item.data;
    let mime = item.mime;
    const m = String(data).match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mime = m[1]; data = m[2]; }
    const ext = MIME_EXT[mime] || 'png';
    const name = `${keyPrefix}-${i}.${ext}`;
    try {
      fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'));
      relPaths.push(`${agent}-${sanitize(agentSessionId)}/${name}`);
    } catch (err) {
      // 写盘失败（Windows 下偶发文件锁）：重试一次，仍失败则告警跳过
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'));
        relPaths.push(`${agent}-${sanitize(agentSessionId)}/${name}`);
      } catch (err2) {
        log.warn('imagestore', `写入失败 ${name}: ${err2.message}`);
      }
    }
  });
  return relPaths;
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}
