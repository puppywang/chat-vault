// Codex Cloud adapter
// 数据源: ~/.chat-vault/imports/codex-cloud/live/<thread-id>.json
//         （由 Chrome 扩展 chatgpt-sync 从 chatgpt.com/local/<thread-id> 推送）
//
// 与 chatgpt adapter 的关系：Codex Cloud 的原始数据在 wss://codex-cloud-backend
// 的 RPC 里（thread/read + thread/items/list），形态和 /backend-api/conversation
// 完全不同。扩展在页面侧已经把它转换成同构的 mapping 树，所以这里**复用**
// chatgpt 的 parseConversation —— 角色与正文的判定规则只保留一份。
//
// 本期只作为独立对话导入，不建立与普通 ChatGPT 对话（/c/）的关联关系。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint } from '../util.js';
import { parseConversation } from './chatgpt.js';

function importRoot() {
  return path.join(os.homedir(), '.chat-vault', 'imports', 'codex-cloud');
}

/** 扩展逐个 thread 推送的落点 */
export function liveDir() {
  return path.join(importRoot(), 'live');
}

/**
 * 写入一个从页面抓来的 Codex Cloud thread。
 * 与 chatgpt 的 live 目录分开，两边的 discover 不会互相扫到。
 */
export function writeLiveConversation(conv) {
  const id = String(conv?.conversation_id || conv?.id || '');
  // 文件名直接来自外部输入，只放行受限字符，杜绝路径穿越
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('conversation id 非法');
  const dir = liveDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(conv));
  fs.renameSync(tmp, file); // 原子替换：sync 正在读旧版本时不会读到半截
  return file;
}

export const codexCloudAdapter = {
  id: 'codex-cloud',

  watchRoots() {
    return [importRoot()];
  },

  discover() {
    return listFiles(liveDir(), '.json');
  },

  // 带解析器版本：改动映射规则时升级版本即可强制重建
  fingerprint: (file) => `v1|${fingerprint(file)}`,

  async parseFile(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 扩展一次推一个 thread；仍兜住数组形态以便将来批量导入
    const list = Array.isArray(parsed) ? parsed : parsed?.mapping ? [parsed] : [];
    const out = [];
    for (const conv of list) {
      const session = parseConversation(conv, path.dirname(filePath));
      if (!session) continue;
      // 工作目录来自 thread.cwd：Codex 在真实仓库里干活，带上它才能按工作区归并
      if (conv.codex_cwd) session.workspacePath = conv.codex_cwd;
      out.push(session);
    }
    return out;
  },
};
