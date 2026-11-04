// OpenAI chat-completions 兼容客户端
// 配置优先级：环境变量 AE_LLM_BASE_URL/AE_LLM_MODEL/AE_LLM_API_KEY
//   > overrides（设置页"测试连接"传入的表单值）
//   > ~/.agent-exporter/config.json 的 llm 字段（config.js 读写）
//   > 项目目录 API_KEY.txt（仅 apiKey 兜底）
// 网关地址与模型必须显式配置（config.json 或环境变量），未配置时 llmChat 直接报错提示。
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';

function readApiKeyFile() {
  // 项目根目录（src 的上一级）或其父目录的 API_KEY.txt；
  // 兼容从任意工作目录启动（计划任务/快捷方式 cwd 不一定是项目根）
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const candidates = [
    path.resolve(process.cwd(), 'API_KEY.txt'),
    path.join(projectRoot, 'API_KEY.txt'),
    path.resolve(process.cwd(), '..', 'API_KEY.txt'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* 无 */ }
  }
  return '';
}

/** 每次调用现读配置（文件极小，且设置页保存后立即生效，无需重启）。overrides 仅测试连接用。 */
export function llmConfig(overrides = {}) {
  const cfg = readConfig().llm;
  const pick = (ov, envKey, cfgKey) => (process.env[envKey] || ov || cfg[cfgKey] || '').trim();
  return {
    baseUrl: pick(overrides.baseUrl, 'AE_LLM_BASE_URL', 'baseUrl'),
    model: pick(overrides.model, 'AE_LLM_MODEL', 'model'),
    apiKey: pick(overrides.apiKey, 'AE_LLM_API_KEY', 'apiKey') || readApiKeyFile(),
  };
}

/** 底层请求：POST {baseUrl}/chat/completions，自带超时；外部 signal 联动中断。
 *  HTTP/网络/网关错误抛 Error */
async function llmRequest(cfg, body, { timeoutMs = 120_000, signal = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`LLM 响应非 JSON: ${text.slice(0, 200)}`); }
    if (data.error) throw new Error(`LLM 网关错误: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 单轮对话（支持 tools）。返回 choices[0].message；网络/HTTP 错误抛 Error */
export async function llmChat(messages, { tools = null, temperature = 0.2, maxTokens = null, timeoutMs = 120_000, signal = null } = {}) {
  const cfg = llmConfig();
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error('AI 助手未配置 LLM 网关：在设置页（⚙️）填写 baseUrl 与 model，或设置环境变量 AE_LLM_BASE_URL / AE_LLM_MODEL，或写 ~/.agent-exporter/config.json（详见 README）');
  }
  const body = { model: cfg.model, messages, temperature };
  if (tools?.length) body.tools = tools;
  if (maxTokens) body.max_tokens = maxTokens;
  const data = await llmRequest(cfg, body, { timeoutMs, signal });
  return data.choices?.[0]?.message ?? null;
}

/** 设置页"测试连接"：用表单值（缺省回落配置）发一次极小请求。返回 {ok, latencyMs, model?, error?}，不抛错 */
export async function llmPing(overrides = {}) {
  const cfg = llmConfig(overrides);
  if (!cfg.baseUrl || !cfg.model) {
    return { ok: false, error: 'baseUrl 与 model 均需填写（或已在配置中）' };
  }
  const t0 = Date.now();
  try {
    await llmRequest(cfg, { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], temperature: 0, max_tokens: 16 }, { timeoutMs: 15_000 });
    return { ok: true, latencyMs: Date.now() - t0, model: cfg.model };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - t0 };
  }
}
