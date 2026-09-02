// MCP (Model Context Protocol) stdio 传输层：让任意 agent 把本工具挂为 MCP server，
// 直接检索/阅读本地对话库，实现对话记录在不同 agent 之间流转。
// 工具清单与执行逻辑见 ./mcp-tools.js（stdio 与 HTTP 传输共用）。
// 协议：JSON-RPC 2.0，stdin/stdout 按行分隔（MCP stdio 传输约定）。
// 铁律：stdout 只输出协议消息，任何日志走 stderr 或落地文件。
import readline from 'node:readline';
import {
  TOOLS, toolExec,
  PROTOCOL_VERSIONS, FALLBACK_VERSION, SERVER_NAME, SERVER_TITLE, VERSION,
} from './mcp-tools.js';

export function startMcp({ db }) {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  const handle = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    const reply = (result) => isRequest && send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => isRequest && send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize': {
        // 客户端声明的版本在支持列表内则跟随，否则回落到最广泛实现的版本
        const want = msg.params?.protocolVersion;
        reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : FALLBACK_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'chatvault', title: 'ChatVault 对话归档检索', version: VERSION },
        });
        return;
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        try {
          const result = toolExec(db, name, msg.params?.arguments || {});
          if (result === undefined) return fail(-32602, `未知工具: ${name}`);
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        } catch (err) {
          // 工具执行失败属于业务错误：按规范放进 result.isError，而不是协议层 error
          console.error(`[mcp] tool ${name} 失败:`, err?.message || err);
          return reply({ content: [{ type: 'text', text: `工具执行失败: ${err?.message || err}` }], isError: true });
        }
      }
      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return; // 通知：不回复
      default:
        return fail(-32601, `方法不存在: ${msg.method}`);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try { handle(msg); } catch (err) {
      console.error('[mcp] 处理异常:', err?.stack || err);
      if (msg?.id !== undefined && msg?.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: String(err?.message || err) } });
      }
    }
  });
  rl.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  console.error(`[chatvault-mcp] 就绪 (工具 ${TOOLS.length} 个)；在 agent 的 MCP 配置中以 node bin/agent-exporter.js mcp 启动`);
}
