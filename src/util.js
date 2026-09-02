// 通用工具：目录扫描、指纹、流式读 JSONL、原始数据瘦身
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** 递归列出 root 下所有匹配 suffix 的文件（带 stat），目录不存在返回 [] */
export function listFiles(root, suffix = '.jsonl') {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(suffix)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch { /* 文件被删/占用则跳过 */ }
      }
    }
  }
  return out;
}

/** 指纹: "size:mtime"，用于增量同步判断 */
export function fingerprint(file) {
  return `${file.size}:${file.mtimeMs}`;
}

/** 流式逐行解析 JSONL，回调返回 false 提前终止 */
export async function readJsonl(filePath, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // 半写行等，跳过
      }
      if (onLine(obj) === false) break;
    }
  } finally {
    rl.close();
  }
}

/** 读取整个 JSON 文件（Copilot 的 .jsonl 实际是单个 JSON 对象） */
export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 原始消息瘦身：剔除 base64 图片等超大字段，超长字符串截断，
 * 保证 content_raw 可控（原始完整数据仍在源文件里，可随时重新解析）。
 */
export function slimJson(value, maxLen = 200, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxLen ? value.slice(0, maxLen) + `…(+${value.length - maxLen})` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => slimJson(v, maxLen, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'data' && typeof v === 'string' && v.length > 512) { out[k] = `[base64 ${v.length} bytes]`; continue; }
    out[k] = slimJson(v, maxLen, depth + 1);
  }
  return out;
}

/** adapter.parseFile 的特殊返回值：本轮无数据（如 daemon 离线），sync 不记录指纹、下轮重试 */
export const RETRY_LATER = Symbol('retry-later');
