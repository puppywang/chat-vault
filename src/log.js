// 落地日志：~/.agent-exporter/logs/app-YYYY-MM-DD.log
// - 按天分文件，保留 14 天（每天清理一次）
// - warn/error 始终镜像到控制台；info 默认只写文件，serve 常驻模式调 setMirror(true) 让窗口可见
// - 级别过滤：环境变量 AE_LOG_LEVEL > config.json logLevel > 默认 info；设置页可运行时切换（setLevel）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let cfgLevel = LEVELS[String(process.env.AE_LOG_LEVEL || '').toLowerCase()]
  ?? LEVELS[readConfig().logLevel] ?? LEVELS.info;
const RETAIN_DAYS = 14;

export const logDir = path.join(os.homedir(), '.chat-vault', 'logs');

let mirrorInfo = false;
let lastPrune = 0;

const pad = (n) => String(n).padStart(2, '0');
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function stamp(d = new Date()) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prune() {
  if (Date.now() - lastPrune < 86400_000) return;
  lastPrune = Date.now();
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
    for (const f of fs.readdirSync(logDir)) {
      const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && new Date(m[1] + 'T12:00:00').getTime() < cutoff) {
        try { fs.unlinkSync(path.join(logDir, f)); } catch { /* 占用等 */ }
      }
    }
  } catch { /* 目录不存在等 */ }
}

function write(level, tag, msg, err) {
  if (LEVELS[level] < cfgLevel) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    let line = `${stamp()} [${level.toUpperCase()}] [${tag}] ${msg}`;
    if (err) line += `\n${(err && err.stack) || err}`;
    fs.appendFileSync(path.join(logDir, `app-${localDate()}.log`), line + '\n');
    prune();
  } catch { /* 日志失败不能影响业务 */ }
  if (mirrorInfo || level === 'warn' || level === 'error') {
    const out = `[${tag}] ${msg}` + (err ? ` (${err.message || err})` : '');
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
  }
}

export const log = {
  debug: (tag, msg) => write('debug', tag, msg),
  info: (tag, msg) => write('info', tag, msg),
  warn: (tag, msg) => write('warn', tag, msg),
  error: (tag, msg, err) => write('error', tag, msg, err),
  /** serve 等常驻进程调用：info 也镜像到控制台（最小化窗口里能看到活动） */
  setMirror(v) { mirrorInfo = v; },
  /** 设置页运行时切换级别（写 config 的同时调用；无效值忽略返回 false） */
  setLevel(name) {
    const lv = LEVELS[String(name || '').toLowerCase()];
    if (!lv) return false;
    cfgLevel = lv;
    return true;
  },
  currentLevel: () => Object.keys(LEVELS).find((k) => LEVELS[k] === cfgLevel) || 'info',
};

/** CLI `logs` 用：返回最新的日志文件路径（可能不存在） */
export function latestLogFile() {
  try {
    const files = fs.readdirSync(logDir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    return files.length ? path.join(logDir, files.at(-1)) : null;
  } catch { return null; }
}
