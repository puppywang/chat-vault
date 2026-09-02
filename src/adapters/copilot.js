// GitHub Copilot (VS Code) adapter
// 数据源: %APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
//
// 文件格式是「行0全量 + 增量补丁」：
//   行0: {"kind":0,"v":{完整会话对象}}            —— 会话基础状态
//   后续: {"kind":1|2,"k":["requests",32,"response"],"v":值} —— 按 k 路径写入的补丁
// （文件被 VS Code 边聊边追加，必须按补丁语义重放才能得到最新状态）
//
// 会话对象: v={sessionId, creationDate(ms), customTitle?, requests:[{timestamp, message:{text},
//           response:[{kind, value,...}]}]}
// assistant 文本在 response[] 中 kind 为 null 且带 value 的元素里（markdown）；kind='thinking' 是思考文本
import path from 'node:path';
import fs from 'node:fs';
import { listFiles, fingerprint } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { saveImages } from '../imagestore.js';

function codeUserDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Code', 'User', 'workspaceStorage') : null;
}

/** 读 workspaceStorage/<hash>/workspace.json 的 folder 字段（在 chatSessions 的上一级） */
export function workspaceOf(filePath, v) {
  try {
    const wsJson = JSON.parse(
      fs.readFileSync(path.join(path.dirname(path.dirname(filePath)), 'workspace.json'), 'utf8')
    );
    const p = normalizeWorkspacePath(wsJson.folder || wsJson.workspace || null);
    if (p) return p;
  } catch { /* 无 workspace.json */ }
  for (const r of v?.requests || []) {
    for (const item of r.response || []) {
      if (item?.baseUri?.path) {
        const p = normalizeWorkspacePath(item.baseUri.path);
        if (p) return p;
      }
    }
  }
  return null;
}

/** 按 k 路径写入补丁；路径中间不存在则跳过该补丁 */
function applyPatch(target, patch) {
  const { kind, k: keys, v: value } = patch;
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    node = node[keys[i]];
    if (node == null || typeof node !== 'object') return;
  }
  const last = keys[keys.length - 1];
  if (kind === 2) {
    // kind:2 = 数组追加：k 指向数组，v 的元素依次 push（VS Code 流式 response 事件、新增 request 均为此语义）
    const arr = node[last];
    if (!Array.isArray(arr) || !Array.isArray(value)) return;
    for (const el of value) arr.push(el);
  } else {
    // kind:1 = 按路径赋值（数组索引可用字符串或数字）
    if (Array.isArray(node) && typeof last === 'string' && /^\d+$/.test(last)) {
      const idx = Number(last);
      if (idx < node.length) node[idx] = value;
      else if (idx === node.length) node.push(value);
    } else {
      node[last] = value;
    }
  }
}

/** 解析「行0全量 + 补丁」格式的 chat session 文件（VS Code chat session v3，供 copilot/antigravity 共用） */
export function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let root;
  try {
    root = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  const session = root?.v ?? root;
  if (!session || typeof session !== 'object') return null;
  // 重放增量补丁
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let patch;
    try {
      patch = JSON.parse(t);
    } catch {
      continue; // 半写行
    }
    if (Array.isArray(patch?.k) && patch.v !== undefined) {
      applyPatch(session, patch);
    }
  }
  return session;
}

export const copilotAdapter = {
  id: 'copilot',

  watchRoots() {
    const dir = codeUserDir();
    return dir ? [dir] : [];
  },

  discover() {
    const dir = codeUserDir();
    return dir ? listFiles(dir, '.jsonl') : [];
  },

  fingerprint,

  async parseFile(filePath) {
    let v;
    try {
      v = parseSessionFile(filePath);
    } catch {
      return null;
    }
    if (!v) return null;
    const requests = Array.isArray(v.requests) ? v.requests : [];
    const sessionId = v.sessionId || path.basename(filePath).replace(/\.jsonl$/i, '');
    const createdAt = v.creationDate ? new Date(v.creationDate).toISOString() : null;

    const messages = [];
    let lastTs = null;
    for (const r of requests) {
      const ts = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : null;
      if (ts) lastTs = ts;
      // 模型：request 级 modelId（形如 copilot/claude-sonnet-4.6 或 customendpoint/...，取末段展示）
      const model = typeof r.modelId === 'string' && r.modelId ? r.modelId.split('/').pop() : null;
      // 用户图片：variableData.variables（{kind:'image', value:{$base64}, mimeType}）；
      // 无 base64 时回退读 references 里的 fsPath（VS Code 落盘于 workspaceStorage/vscode-chat-images/）
      const imgItems = [];
      for (const v of (r.variableData?.variables ?? [])) {
        if (v?.kind !== 'image') continue;
        const b64 = v.value?.$base64;
        if (typeof b64 === 'string' && b64) {
          imgItems.push({ data: b64, mime: v.mimeType });
        } else {
          const fsPath = v.references?.[0]?.reference?.fsPath;
          if (typeof fsPath === 'string' && fs.existsSync(fsPath)) {
            imgItems.push({ data: fs.readFileSync(fsPath).toString('base64'), mime: v.mimeType });
          }
        }
      }

      const userText = typeof r.message?.text === 'string' ? r.message.text.trim() : '';
      const userImages = imgItems.length
        ? saveImages(copilotAdapter.id, sessionId, `r${messages.length}`, imgItems)
        : [];
      if (userText || userImages.length) {
        messages.push({
          role: 'user',
          createdAt: ts,
          text: userText || '[图片]',
          raw: { text: userText.slice(0, 200) },
          images: userImages,
        });
      }
      // 按事件顺序遍历 response：kind:null 是 markdown 文本，inlineReference 是行内符号/文件引用
      // （转成行内代码保持原位，否则 `t3d_1`、`data.js` 这类词会丢失），thinking 是思考文本
      const refName = (ref) => {
        if (!ref || typeof ref !== 'object') return null;
        if (typeof ref.name === 'string' && ref.name) return ref.name;              // 符号引用
        const p = ref.fsPath || ref.location?.uri?.fsPath;                            // 文件引用（URI 对象）
        if (typeof p === 'string' && p) return p.split(/[\\/]/).pop();
        return null;
      };
      const thinkParts = [];
      const respParts = [];
      for (const item of Array.isArray(r.response) ? r.response : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.kind === 'thinking' && typeof item.value === 'string' && item.value) {
          thinkParts.push(item.value);
        } else if (item.kind === 'inlineReference') {
          const n = refName(item.inlineReference);
          if (n) respParts.push('`' + n + '`');
        } else if (item.kind == null && typeof item.value === 'string' && item.value) {
          respParts.push(item.value);
        }
      }
      if (thinkParts.length) {
        messages.push({ role: 'thinking', createdAt: ts, text: thinkParts.join('\n'), raw: null, model });
      }
      if (respParts.length) {
        const text = respParts.join('').replace(/\n{3,}/g, '\n\n');
        messages.push({
          role: 'assistant',
          createdAt: ts,
          text,
          raw: null,
          model,
        });
      }
    }

    if (!messages.length) return null;
    const title =
      (typeof v.customTitle === 'string' && v.customTitle.trim()) ||
      (messages.find((m) => m.role === 'user')?.text.split('\n')[0].slice(0, 80)) ||
      '(无标题会话)';
    return {
      agentSessionId: sessionId,
      workspacePath: workspaceOf(filePath, v),
      title,
      createdAt,
      updatedAt: lastTs ?? createdAt,
      messages,
    };
  },
};
