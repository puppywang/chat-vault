// 通用工具：目录扫描、指纹、流式读 JSONL、原始数据瘦身
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

/** node:zlib 的流式 zstd 解压（Node ≥ 22.15）；缺失时 .zst 数据源自动跳过 */
export const HAS_ZSTD_STREAM = typeof zlib.createZstdDecompress === 'function';

/** 递归列出 root 下所有匹配 suffix（字符串或数组）的文件（带 stat），目录不存在返回 [] */
export function listFiles(root, suffix = '.jsonl') {
  const suffixes = (Array.isArray(suffix) ? suffix : [suffix]).map((s) => s.toLowerCase());
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
      else if (e.isFile() && suffixes.some((s) => e.name.toLowerCase().endsWith(s))) {
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

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * zstd 文件是否完整：逐帧走帧头 + 块头链（RFC 8878），只读头部、不解压，
 * 要求文件恰好结束在某帧末尾。node:zlib 的 zstd 解压遇到截断输入不报错，
 * 静默产出半截（甚至空）内容，所以读之前要自己确认。
 */
export function zstdFileComplete(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(18);
    const readAt = (pos, n) => fs.readSync(fd, hdr, 0, n, pos) === n;
    let off = 0;
    let frames = 0;
    while (off < size) {
      if (!readAt(off, 4)) return false;
      const magic = hdr.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) { // 可跳过帧：magic + 4 字节长度 + 数据
        if (!readAt(off + 4, 4)) return false;
        off += 8 + hdr.readUInt32LE(0);
        continue;
      }
      if (magic !== ZSTD_MAGIC) return false;
      let p = off + 4;
      if (!readAt(p, 1)) return false;
      const fhd = hdr[0]; p += 1;
      const fcsFlag = (fhd >> 6) & 3;
      const single = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const dictIdFlag = fhd & 3;
      if (!single) p += 1;
      p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
      p += [0, 1, 2, 4][dictIdFlag];
      let last = 0;
      do {
        if (!readAt(p, 3)) return false;
        const bh = hdr.readUIntLE(0, 3); p += 3;
        last = bh & 1;
        const type = (bh >> 1) & 3;
        if (type === 3) return false;
        p += type === 1 ? 1 : (bh >> 3) & 0x1fffff;
      } while (!last);
      if (checksum) p += 4;
      if (p > size) return false;
      off = p;
      frames++;
    }
    return frames > 0 && off === size;
  } finally {
    fs.closeSync(fd);
  }
}

/** 流式逐行解析 JSONL（.zst 结尾的走流式 zstd 解压），回调返回 false 提前终止 */
export async function readJsonl(filePath, onLine) {
  let input;
  let decodeError = null;
  if (/\.zst$/i.test(filePath)) {
    if (!HAS_ZSTD_STREAM) throw new Error('当前 Node 不支持 zstd 解压（需 ≥ 22.15）');
    if (!zstdFileComplete(filePath)) throw new Error(`zstd 文件不完整或已损坏: ${filePath}`);
    const raw = fs.createReadStream(filePath);
    input = zlib.createZstdDecompress();
    // pipe 不转发错误：截断/损坏的帧要让本次解析失败，而不是悄悄读到一半
    raw.on('error', (err) => input.destroy(err));
    input.on('error', (err) => { decodeError = err; });
    raw.pipe(input);
  } else {
    input = fs.createReadStream(filePath, { encoding: 'utf8' });
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
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
    if (typeof input.destroy === 'function') input.destroy();
  }
  if (decodeError) throw decodeError;
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
