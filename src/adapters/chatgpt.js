// ChatGPT 网页/客户端 官方数据导出 adapter
// 数据源: ~/.chat-vault/imports/chatgpt/**/conversations.json
//         （设置 → 数据管控 → 导出数据，邮件拿到 zip，解压后整个目录丢进来；
//           图片要靠同目录的 file-<id>-<名字> 附件解析，所以别只放 json）
//         另可用环境变量 CHATVAULT_CHATGPT_EXPORT 追加一个目录。
//
// 与其它 agent 的根本差异：这是**手动导出的快照**，不是 agent 实时写的日志。
// 没有工作区（网页对话不绑目录），也不会被 watcher 实时更新——重新导出覆盖同名
// 目录后，指纹变化才会重新入库。
//
// 格式：顶层是会话数组，每个会话的 mapping 是 uuid -> {id, message, parent, children}
// 的**树**（每次重新生成/编辑提问都长一个分支），current_node 指向当前分支的叶子。
// 这里只收 current_node 回溯到根的那条链——即你在网页上看到的那个版本；被重新生成
// 顶掉的旧分支不入库（与 pi 的处理相反：pi 的放弃分支留在文件里且有独立时间线，
// 这里的旧分支是"同一句话的另一个版本"，收进来只会让检索结果重复）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, slimJson } from '../util.js';
import { saveImages } from '../imagestore.js';
import '../../extensions/chatgpt-sync/conversation-merge.js';

const { ChatVaultConversationMerge } = globalThis;

const TOOL_TEXT_LIMIT = 4000;
const MAX_IMAGES_PER_MESSAGE = 8;

function importRoots() {
  const roots = [path.join(os.homedir(), '.chat-vault', 'imports', 'chatgpt')];
  const extra = process.env.CHATVAULT_CHATGPT_EXPORT;
  if (extra && extra.trim()) roots.push(extra.trim());
  return roots;
}

/** 浏览器扩展逐个对话同步的落点（每个对话一个文件，附件在 assets/ 下） */
export function liveDir() {
  return path.join(importRoots()[0], 'live');
}

/**
 * 写入一个从网页抓来的对话。
 * 网页 backend-api 返回的对象与导出里的会话元素同构，所以落成文件后照常走
 * parseFile —— 解析规则只有一份，网页同步和手动导出不会解析出两种结果。
 *
 * assets: { "file-ABC": { mime, data(base64) } }，图片字节不在对话 JSON 里，
 * 由扩展另外取好一起送来，落到 assets/ 供 asset_pointer 反查。
 */
export function writeLiveConversation(conv, assets = null) {
  const id = String(conv?.conversation_id || conv?.id || '');
  // 文件名直接来自外部输入，只放行 uuid 形态，杜绝路径穿越
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('conversation id 非法');
  const dir = liveDir();
  fs.mkdirSync(dir, { recursive: true });

  if (assets && typeof assets === 'object') {
    const assetDir = path.join(dir, 'assets');
    fs.mkdirSync(assetDir, { recursive: true });
    for (const [key, item] of Object.entries(assets)) {
      if (!/^file[-_][A-Za-z0-9]{1,64}$/.test(key)) continue;
      const ext = Object.entries(IMAGE_MIME).find(([, m]) => m === item?.mime)?.[0];
      if (!ext || typeof item.data !== 'string') continue;
      try {
        fs.writeFileSync(path.join(assetDir, `${key}${ext}`), Buffer.from(item.data, 'base64'));
      } catch { /* 单张图失败不影响正文入库 */ }
    }
  }

  const file = path.join(dir, `${id}.json`);
  // 扩展只送页面自己读到的数据（多为最近几轮的分页），并进已归档的整棵树，不整段覆盖
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次同步或文件损坏：直接写入 */ }
  const merged = ChatVaultConversationMerge.merge(existing?.mapping ? existing : null, conv);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged));
  fs.renameSync(tmp, file); // 原子替换：sync 正在读旧版本时不会读到半截
  return file;
}

/** 导出里的时间是 unix 秒（浮点，含毫秒小数） */
function iso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Math.round(seconds * 1000)).toISOString();
}

function clip(text, limit) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}\n…(截断，共 ${s.length} 字符)` : s;
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((x) => x.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

/**
 * 导出目录里的附件索引：asset_pointer 只给 file-<id>，真实文件名是
 * file-<id>-<原始名>.<ext>（DALL·E 产物在 dalle-generations/ 下），按 id 前缀查。
 * 一个导出目录建一次，避免每条消息重扫。
 */
const assetIndexCache = new Map();
function assetIndex(dir) {
  let index = assetIndexCache.get(dir);
  if (index) return index;
  index = new Map();
  const walk = (d, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name), depth + 1); continue; }
      // file-ABC123-name.png / file_0000abcd-name.webp：截到第二个分隔符前即 id
      const m = /^(file[-_][A-Za-z0-9]+)/.exec(e.name);
      if (m && !index.has(m[1])) index.set(m[1], path.join(d, e.name));
    }
  };
  walk(dir, 0);
  assetIndexCache.set(dir, index);
  return index;
}

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

/** asset_pointer: "file-service://file-ABC" | "sediment://file_0000" | "file-ABC" */
function resolveAsset(dir, pointer) {
  if (typeof pointer !== 'string' || !pointer) return null;
  const id = pointer.slice(pointer.lastIndexOf('/') + 1);
  const file = assetIndex(dir).get(id);
  if (!file) return null;
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    return { data: fs.readFileSync(file).toString('base64'), mime };
  } catch {
    return null; // 导出目录被动过/文件缺失：正文照收
  }
}

/**
 * 把一条 message 的 content 摊平成 {text, images, kind}。
 * kind 用于修正角色（thinking / tool），content_type 未知时保底转 JSON 摘要。
 */
function flattenContent(content, dir) {
  const images = [];
  const pushAsset = (pointer) => {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) return;
    const item = resolveAsset(dir, pointer);
    if (item) images.push(item);
  };

  if (!content || typeof content !== 'object') return { text: '', images, kind: 'text' };

  switch (content.content_type) {
    case 'text':
      return {
        text: (content.parts || []).filter((p) => typeof p === 'string').join('\n').trim(),
        images, kind: 'text',
      };

    case 'multimodal_text': {
      const texts = [];
      for (const part of content.parts || []) {
        if (typeof part === 'string') { texts.push(part); continue; }
        if (!part || typeof part !== 'object') continue;
        if (part.content_type === 'image_asset_pointer') { pushAsset(part.asset_pointer); continue; }
        // 语音转写等带 text 的分片
        if (typeof part.text === 'string') texts.push(part.text);
      }
      return { text: texts.join('\n').trim(), images, kind: 'text' };
    }

    case 'code': {
      // 空 text 不能包成空代码围栏——连接器类调用的 text 常常就是空的（载荷不落
      // 在会话里），包了就是一整屏 ``` 噪声。留空交给调用方去 metadata 里还原。
      const code = String(content.text ?? '').trim();
      return { text: code ? `\`\`\`${content.language || ''}\n${code}\n\`\`\`` : '', images, kind: 'tool' };
    }

    case 'execution_output':
      return { text: String(content.text ?? '').trim(), images, kind: 'tool' };

    // 推理摘要：新版把思考过程存这两种
    case 'thoughts': {
      const text = (content.thoughts || [])
        .map((t) => [t?.summary, t?.content].filter(Boolean).join('\n'))
        .filter(Boolean).join('\n\n').trim();
      return { text, images, kind: 'thinking' };
    }
    case 'reasoning_recap':
      return { text: String(content.content ?? '').trim(), images, kind: 'thinking' };

    // 联网检索的展示块与引用
    case 'tether_browsing_display':
      return { text: String(content.result ?? content.summary ?? '').trim(), images, kind: 'tool' };
    case 'tether_quote':
      return {
        text: [content.title, content.url, content.text].filter(Boolean).join('\n').trim(),
        images, kind: 'tool',
      };

    case 'system_error':
      return { text: [content.name, content.text].filter(Boolean).join(': ').trim(), images, kind: 'system' };

    // 自定义指令：以隐藏系统消息的形式存在每个会话里
    case 'user_editable_context':
      return {
        text: [content.user_profile, content.user_instructions].filter(Boolean).join('\n').trim(),
        images, kind: 'system',
      };

    default: {
      // 未知 content_type：留个可读摘要，别丢数据也别把库撑爆
      if (Array.isArray(content.parts)) {
        const texts = content.parts.filter((p) => typeof p === 'string');
        if (texts.length) return { text: texts.join('\n').trim(), images, kind: 'text' };
      }
      if (typeof content.text === 'string') return { text: content.text.trim(), images, kind: 'text' };
      return { text: clip(JSON.stringify(slimJson(content, 200)), TOOL_TEXT_LIMIT), images, kind: 'tool' };
    }
  }
}

/** current_node 缺失/悬空时，退而取时间最新的叶子 */
function pickLeaf(mapping) {
  let best = null;
  let bestTime = -1;
  for (const [id, node] of Object.entries(mapping)) {
    const children = Array.isArray(node?.children) ? node.children.filter((c) => mapping[c]) : [];
    if (children.length) continue;
    const t = typeof node?.message?.create_time === 'number' ? node.message.create_time : 0;
    if (t >= bestTime) { bestTime = t; best = id; }
  }
  return best;
}

/** 从叶子回溯到根，返回根→叶顺序的节点链 */
function activeChain(mapping, currentNode) {
  let id = currentNode && mapping[currentNode] ? currentNode : pickLeaf(mapping);
  const chain = [];
  const seen = new Set();
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    chain.push(mapping[id]);
    id = mapping[id].parent;
  }
  return chain.reverse();
}

export function parseConversation(conv, dir) {
  const mapping = conv?.mapping;
  if (!mapping || typeof mapping !== 'object') return null;
  const sessionId = conv.conversation_id || conv.id;
  if (!sessionId) return null;

  const messages = [];
  const defaultModel = conv.default_model_slug || null;

  for (const node of activeChain(mapping, conv.current_node)) {
    const msg = node.message;
    if (!msg) continue; // 根节点是个空壳
    const role = msg.author?.role;
    let { text, images: imageItems, kind } = flattenContent(msg.content, dir);

    // MCP 连接器（如 Chappie）和联网检索的调用，实际载荷不在会话 JSON 里——
    // content.text 是空的，能还原的只有 metadata：调了哪个端点（invoked_resource）
    // 和模型自述这步在干什么（reasoning_title）。丢掉就等于整段工作过程没了，
    // 这两个字段实测覆盖 111/114，且几乎条条不同。
    let toolHint = null;
    if (!text) {
      const res = msg.metadata?.invoked_resource;
      const endpoint = res
        ? [res.app_name, String(res.resource_uri || '').split('/').filter(Boolean).pop()]
          .filter(Boolean).join('/')
        : null;
      const title = String(msg.metadata?.reasoning_title || '').trim();
      if (title || endpoint) {
        text = title || endpoint;
        toolHint = endpoint;
        kind = 'tool';
      }
    }

    const images = imageItems.length
      ? saveImages(chatgptAdapter.id, sessionId, `m${messages.length}`, imageItems)
      : [];
    if (!text && !images.length) continue;

    const at = iso(msg.create_time);
    const model = msg.metadata?.model_slug || defaultModel;
    const raw = {
      id: msg.id,
      parent: node.parent,
      role,
      content_type: msg.content?.content_type,
      recipient: msg.recipient,
      hidden: msg.metadata?.is_visually_hidden_from_conversation || undefined,
      // chappie 的 wfr_* 请求 id：与 chappie.state.json 的 joins 精确对应，
      // 是 ChatGPT 网页对话与 pi 会话之间唯一确定的连接点
      request_id: msg.metadata?.request_id,
    };

    // 自定义指令是隐藏的上下文块，不是任何人的发言；它的 author.role 各版本里
    // 出现过 system 也出现过 user，按 content_type 判定才稳。
    if (msg.content?.content_type === 'user_editable_context') {
      messages.push({ role: 'system', createdAt: at, text: `[custom_instructions] ${text}`, raw, images });
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', createdAt: at, text: text || '(图片消息)', raw, images });
      continue;
    }

    if (role === 'tool') {
      const name = toolHint || msg.author?.name || 'tool';
      messages.push({
        role: 'tool',
        createdAt: at,
        // toolHint 非空说明这条没有真实载荷、正文是从 metadata 还原的，
        // 它描述的是"发起了哪次调用"而不是返回值，标成 result 会误导
        text: `[tool${toolHint ? '' : '_result'}:${name}] ${clip(text || '(图片结果)', TOOL_TEXT_LIMIT)}`,
        raw, images, model,
      });
      continue;
    }

    if (role === 'assistant') {
      if (kind === 'thinking') {
        messages.push({ role: 'thinking', createdAt: at, text, raw, model });
        continue;
      }
      // 两种都不是"对用户说话"：recipient 不是 all 说明这条是发给工具的调用；
      // 联网检索展示块等 content_type 本身就是工具产物（recipient 仍是 all）。
      const target = typeof msg.recipient === 'string' && msg.recipient && msg.recipient !== 'all'
        ? msg.recipient : null;
      const toolLabel = toolHint || target
        || (kind === 'tool' ? (msg.author?.name || msg.content?.content_type || 'tool') : null);
      messages.push({
        role: toolLabel ? 'tool' : 'assistant',
        createdAt: at,
        text: toolLabel ? `[tool:${toolLabel}] ${clip(text, TOOL_TEXT_LIMIT)}` : text,
        raw, images, model,
      });
      continue;
    }

    messages.push({ role: 'system', createdAt: at, text, raw, images });
  }

  if (!messages.length) return null;
  const firstUser = messages.find((m) => m.role === 'user' && m.text !== '(图片消息)');
  const title = (typeof conv.title === 'string' && conv.title.trim())
    ? conv.title.trim().slice(0, 200)
    : (firstUser && firstLine(firstUser.text)) || '(无标题会话)';

  return {
    agentSessionId: String(sessionId),
    workspacePath: null, // 网页对话不绑工作目录
    title,
    createdAt: iso(conv.create_time) || messages[0].createdAt,
    updatedAt: iso(conv.update_time) || messages[messages.length - 1].createdAt,
    messages,
  };
}

export const chatgptAdapter = {
  id: 'chatgpt',

  watchRoots() {
    return importRoots();
  },

  discover() {
    // 手动导出的整包 + 扩展逐个同步的单对话文件（后者文件名是 <conversation_id>.json）
    return [
      ...importRoots().flatMap((root) => listFiles(root, 'conversations.json')),
      ...listFiles(liveDir(), '.json'),
    ];
  },

  fingerprint: (file) => `v3|${fingerprint(file)}`,

  // 整个导出是一个 JSON 数组 = 多会话，一次性读进内存（重度用户可能上百 MB，
  // 但导出是低频手动动作，不值得为它引流式 JSON 解析）
  async parseFile(filePath) {
    const dir = path.dirname(filePath);
    assetIndexCache.delete(dir); // 同一目录重新导入时重建附件索引
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 三种形态：导出的会话数组 / 少数导出包的 {conversations:[...]} / 扩展送来的单个对话
    const list = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.conversations) ? parsed.conversations
      : parsed?.mapping ? [parsed] : [];
    const out = [];
    for (const conv of list) {
      const session = parseConversation(conv, dir);
      if (session) out.push(session);
    }
    return out;
  },
};
