// 运行时配置：~/.agent-exporter/config.json
// - readConfig：默认值 + 文件浅合并（未知顶层键原样保留，升级不丢字段）
// - writeConfig：字段校验 → 合并到现有内容 → 临时文件原子替换
// 刻意不依赖 log.js（log 反向依赖本模块），失败只抛错由调用方处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.chat-vault', 'config.json');

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const DEFAULTS = {
  llm: { baseUrl: '', model: '', apiKey: '' },
  logLevel: 'info',
  lan: false,            // true = 监听 0.0.0.0 允许局域网访问；默认仅本机
  disabledAgents: [],    // 关闭同步的 agent id 列表
  autoHideRetryCorpses: false, // 同步时自动隐藏"重试残骸"会话（全部用户消息都是"请继续"类）
  backup: {
    enabled: false,               // 显式开关；host 未配置时同样不会跑
    host: '',                     // ssh 目标：~/.ssh/config 别名 或 user@host
    dir: '/srv/backup/chatvault', // 远端根目录（绝对路径）
    transport: 'auto',            // auto 优先 rsync，缺 rsync 时退化为 ssh 流式 gzip
    resticBinary: '',             // 空 = ~/.chat-vault/bin/restic(.exe)
    resticPasswordFile: '',       // 空 = ~/.chat-vault/restic/password.txt（不备份此密钥）
    resticRepository: '',         // 空 = rclone:chatvault，经受限 SSH helper 访问独立仓库
    stagingDir: '',               // 本地快照暂存目录；空 = ~/.chat-vault/backup-staging
    keepLocal: 3,                 // 本地暂存保留份数（推送成功前不删）
    keepWeekly: 8,
    keepMonthly: 3,
    excludeFts: true,             // 快照不带 messages_fts（恢复时 rebuild）
    timeoutSec: 900,
  },
};

export const BACKUP_TRANSPORTS = ['auto', 'rsync', 'ssh', 'restic'];

export function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* 无文件或坏 JSON：全默认 */ }
  return {
    ...DEFAULTS,
    ...file,
    llm: { ...DEFAULTS.llm, ...(file.llm || {}) },
    backup: { ...DEFAULTS.backup, ...(file.backup || {}) },
    disabledAgents: Array.isArray(file.disabledAgents) ? file.disabledAgents.filter((x) => typeof x === 'string') : [],
  };
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/** 校验并写入 patch（顶层键可选提供，只改给出的键）。失败抛 Error。 */
export function writeConfig(patch = {}) {
  // 以原始文件为基底（而非 readConfig 的默认形状），未识别的顶层键原样保留
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 无文件或坏 JSON */ }
  const out = {
    ...DEFAULTS,
    ...raw,
    llm: { ...DEFAULTS.llm, ...(raw.llm || {}) },
    backup: { ...DEFAULTS.backup, ...(raw.backup || {}) },
    disabledAgents: Array.isArray(raw.disabledAgents) ? raw.disabledAgents : [],
  };

  if (patch.llm !== undefined) {
    if (typeof patch.llm !== 'object' || patch.llm === null) throw new Error('llm 必须是对象');
    if ('baseUrl' in patch.llm) {
      const v = str(patch.llm.baseUrl, 500);
      if (v === null || (v !== '' && !/^https?:\/\//.test(v))) throw new Error('baseUrl 需为 http(s) 地址或留空');
      out.llm.baseUrl = v.trim();
    }
    if ('model' in patch.llm) {
      const v = str(patch.llm.model, 200);
      if (v === null) throw new Error('model 需为字符串');
      out.llm.model = v.trim();
    }
    // apiKey 空串 = 显式清除；缺键 = 保持不变（掩码 UI 不会覆盖已有 key）
    if ('apiKey' in patch.llm) {
      const v = str(patch.llm.apiKey, 500);
      if (v === null) throw new Error('apiKey 需为字符串');
      out.llm.apiKey = v.trim();
    }
  }
  if (patch.logLevel !== undefined) {
    if (!LOG_LEVELS.includes(patch.logLevel)) throw new Error(`logLevel 需为 ${LOG_LEVELS.join('/')}`);
    out.logLevel = patch.logLevel;
  }
  if (patch.lan !== undefined) {
    if (typeof patch.lan !== 'boolean') throw new Error('lan 需为布尔值');
    out.lan = patch.lan;
  }
  if (patch.disabledAgents !== undefined) {
    if (!Array.isArray(patch.disabledAgents) || patch.disabledAgents.some((x) => typeof x !== 'string')) {
      throw new Error('disabledAgents 需为字符串数组');
    }
    out.disabledAgents = [...new Set(patch.disabledAgents)];
  }
  if (patch.autoHideRetryCorpses !== undefined) {
    if (typeof patch.autoHideRetryCorpses !== 'boolean') throw new Error('autoHideRetryCorpses 需为布尔值');
    out.autoHideRetryCorpses = patch.autoHideRetryCorpses;
  }
  if (patch.backup !== undefined) {
    if (typeof patch.backup !== 'object' || patch.backup === null) throw new Error('backup 必须是对象');
    const b = patch.backup;
    const bool = (k) => { if (typeof b[k] !== 'boolean') throw new Error(`backup.${k} 需为布尔值`); out.backup[k] = b[k]; };
    const int = (k, min, max) => {
      if (!Number.isInteger(b[k]) || b[k] < min || b[k] > max) throw new Error(`backup.${k} 需为 ${min}~${max} 的整数`);
      out.backup[k] = b[k];
    };
    if ('enabled' in b) bool('enabled');
    if ('host' in b) {
      const v = str(b.host, 200);
      // ssh 目标既不允许空白也不允许首字符 '-'（避免被当成 ssh 选项）
      if (v === null || /\s/.test(v) || v.startsWith('-')) throw new Error('backup.host 需为 ssh 别名或 user@host');
      out.backup.host = v.trim();
    }
    if ('dir' in b) {
      const v = str(b.dir, 500);
      if (v === null || v === '' || v[0] !== '/') throw new Error('backup.dir 需为远端绝对路径');
      out.backup.dir = v;
    }
    if ('transport' in b) {
      if (!BACKUP_TRANSPORTS.includes(b.transport)) throw new Error(`backup.transport 需为 ${BACKUP_TRANSPORTS.join('/')}`);
      out.backup.transport = b.transport;
    }
    if ('stagingDir' in b) {
      const v = str(b.stagingDir, 500);
      if (v === null) throw new Error('backup.stagingDir 需为字符串');
      out.backup.stagingDir = v;
    }
    for (const key of ['resticBinary', 'resticPasswordFile', 'resticRepository']) {
      if (key in b) {
        const value = str(b[key], 1000);
        if (value === null || /[\r\n\0]/.test(value)) throw new Error(`backup.${key} 需为单行字符串`);
        out.backup[key] = value;
      }
    }
    if ('keepLocal' in b) int('keepLocal', 1, 30);
    if ('keepWeekly' in b) int('keepWeekly', 0, 200);
    if ('keepMonthly' in b) int('keepMonthly', 0, 200);
    if ('excludeFts' in b) bool('excludeFts');
    if ('timeoutSec' in b) int('timeoutSec', 30, 7200);
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return out;
}
