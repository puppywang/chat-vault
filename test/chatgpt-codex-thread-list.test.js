import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createCodexThreadLinks } from '../src/codex-thread-links.js';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/codex-thread.js', import.meta.url), 'utf8');
const context = { setTimeout, clearTimeout, atob, crypto: { randomUUID: () => 'r' } };
vm.runInNewContext(source, context);
const api = context.__cvCodexThread;
const ROOT = '01a12a0c-a652-7599-a770-0e76576cdff3';
const ROOT2 = '01a12767-6670-7784-b653-425e2584a197';
const SUB = '01a12a10-0000-7000-8000-8dc4ee88ebcb';
const CONV = '6acc890d-4fd8-83ec-a00a-472f2b5421c8';
const ENV = 'ccarenv_b64_Y2NhcmVudl82YWE4MTU0OTY0Y2M4MTkxYTlkNzI0ODBjMzZhODU0MA';
const CONV2 = '6ab0cd7b-6208-83ec-af15-878d70af2164';

test('Codex 根线程列表：只留 ChatGPT 网页创建的根线程，跨页翻完，字段精简；关闭连接', async () => {
  const calls = [];
  let closed = 0;
  const pages = {
    null: { data: [
      { id: ROOT, originator: 'chatgpt_cca', parentThreadId: null, threadSource: null, model: 'gpt-6-astra', reasoningEffort: 'ultra',
        cwd: '/workspace/scratch/fb137abfd2ea', status: { type: 'idle' }, createdAt: 1791706839, updatedAt: 1791888178, name: null, preview: '',
        environments: [{ environmentId: ENV, cwd: '/workspace/scratch/fb137abfd2ea' }] },
      { id: SUB, originator: 'chatgpt_cca', parentThreadId: ROOT, threadSource: 'subagent' },
      { id: '01a12a11-0000-7000-8000-ef3f1bf6b6c1', originator: 'codex_vscode', parentThreadId: null }],
      nextCursor: 'c2' },
    c2: { data: [{ id: ROOT2, originator: 'chatgpt_cca', status: { type: 'active' }, environments: [{ environmentId: ENV, cwd: '/workspace/scratch/61c588c2126b' }],
      recencyAt: 1791882819 }], nextCursor: null },
  };
  const connectImpl = async () => ({ request: async (method, params) => {
    calls.push([method, params.cursor, params.archived]); return pages[params.cursor]; },
    close: () => { closed++; } });
  const r = await api.listRoots('tok', { connectImpl });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['thread/list', null, false], ['thread/list', 'c2', false]], '不再查环境状态');
  assert.equal(closed, 1);
  assert.equal(r.truncated, false);
  assert.deepEqual(JSON.parse(JSON.stringify(r.threads)), [
    { threadId: ROOT, url: `https://chatgpt.com/local/${ROOT}?hostId=local`, name: null, model: 'gpt-6-astra', reasoningEffort: 'ultra',
      cwd: '/workspace/scratch/fb137abfd2ea', status: 'idle', createdAt: 1791706839, updatedAt: 1791888178, archived: false },
    { threadId: ROOT2, url: `https://chatgpt.com/local/${ROOT2}?hostId=local`, name: null, model: null, reasoningEffort: null,
      cwd: '/workspace/scratch/61c588c2126b', status: 'active', createdAt: null, updatedAt: 1791882819, archived: false }]);
  const capped = await api.listRoots('tok', { connectImpl, maxPages: 1 });
  assert.equal(capped.truncated, true);
});

test('线程 ↔ 对话：协作记录 senderThreadId 为确认、工作目录为候选；ChatVault 归档补标题；本地关联的对话补标题', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-codex-links-'));
  const live = path.join(home, '.chat-vault', 'imports', 'chatgpt', 'live');
  fs.mkdirSync(live, { recursive: true });
  const conv = (id, title, mapping) => JSON.stringify({ conversation_id: id, title, update_time: 1791700000, mapping });
  fs.writeFileSync(path.join(live, `${CONV}.json`), conv(CONV, '实现 iPhone Duo 升级', {
    a: { message: { metadata: { codex_collab_agent_tool_call: { tool: 'spawnAgent', senderThreadId: ROOT.toUpperCase() } }, content: { parts: ['x'] } } } }));
  fs.writeFileSync(path.join(live, `${CONV2}.json`), conv(CONV2, '提到同一目录', {
    a: { message: { metadata: {}, content: { parts: ['cwd 是 /workspace/scratch/61c588c2126b'] } } } }));
  fs.writeFileSync(path.join(live, 'broken.json'), '{');
  const queries = [];
  const db = { prepare: sql => ({ all: (agent, ...ids) => {
    queries.push([agent, ids]);
    if (agent === 'codex-cloud') return ids.includes(`codex-${ROOT}`) ? [{ id: 2284, agent_session_id: `codex-${ROOT}`, title: 'Codex Cloud · 连接 01a12a09', message_count: 828, updated_at: 'u' }] : [];
    return ids.map(id => ({ id: 9, agent_session_id: id, title: '只在库里的对话', message_count: 3, updated_at: 'u2' }));
  } }) };
  const links = createCodexThreadLinks({ homeDir: home });
  const OTHER_CONV = '11111111-2222-4333-8444-df1008f4a5a6';
  const r = links.annotate(db, { threads: [{ threadId: ROOT, cwd: '/workspace/scratch/fb137abfd2ea' }, { threadId: ROOT2, cwd: '/workspace/scratch/61c588c2126b' }, { threadId: 'bad' }],
    conversationIds: [CONV, OTHER_CONV, 'nope'] });
  assert.deepEqual(Object.keys(r.threads), [ROOT, ROOT2]);
  assert.equal(r.threads[ROOT].chatvault.sessionId, 2284);
  assert.deepEqual(r.threads[ROOT].links.map(l => [l.conversationId, l.via]), [[CONV, 'sender']]);
  assert.deepEqual(r.threads[ROOT2].links.map(l => [l.conversationId, l.via]), [[CONV2, 'workspace']]);
  assert.equal(r.threads[ROOT2].chatvault, null);
  assert.equal(r.conversations[CONV].title, '实现 iPhone Duo 升级', '已归档文件里的标题');
  assert.equal(r.conversations[OTHER_CONV].title, '只在库里的对话', '其余的查库');
  assert.deepEqual(queries.find(q => q[0] === 'chatgpt')[1], [OTHER_CONV], '已有文件的对话不再查库');
  // 增量：文件不变时不重新解析
  const first = links._scan();
  assert.equal(links._scan()[0], first[0]);
});

test('检查能否恢复：逐个发 thread/resume，成功带 resumeKind，被拒带错误，超时单独记，连接只开一次并关闭', async () => {
  const A = '01a12a0c-a652-7599-a770-0e76576cdff3', B = '01a0c2a3-474e-7133-a748-193ca2ccb323', C = '01a12767-6670-7784-b653-425e2584a197';
  const calls = []; let opts = null, closed = 0;
  const connectImpl = async (token, o) => { opts = o; return {
    request: async (method, params, ro) => {
      calls.push([method, params.threadId, ro.timeoutMs]);
      if (params.threadId === A) return { resumeKind: 'warm', thread: {} };
      if (params.threadId === B) throw Object.assign(new Error('Something went wrong.'), { code: -32603 });
      throw Object.assign(new Error('timeout'), { code: 'CODEX_REQUEST_TIMEOUT' });
    }, close: () => { closed++; } }; };
  const seen = [];
  const r = await api.probeResume('tok', [A, B, C, A.toUpperCase(), 'bad'], { connectImpl, onResult: x => seen.push(x.threadId), timeoutMs: 5000, concurrency: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(opts)), { allowMethods: ['thread/resume'] });
  assert.equal(closed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)).map(c => c[1]).sort(), [A, B, C].sort(), '去重、忽略无效 ID');
  assert.ok(calls.every(c => c[0] === 'thread/resume' && c[2] === 5000));
  const by = Object.fromEntries(r.map(x => [x.threadId, [x.outcome, x.resumeKind ?? null, x.error ?? null]]));
  assert.deepEqual(JSON.parse(JSON.stringify(by)), { [A]: ['resumed', 'warm', null], [B]: ['failed', null, 'Something went wrong.'], [C]: ['timeout', null, null] });
  assert.equal(seen.length, 3);
});

test('只读连接默认拒绝 thread/resume，显式放行后才可用', async () => {
  class FakeWS { constructor() { this.readyState = 0; this.l = {}; setTimeout(() => { this.readyState = 1; (this.l.open || []).forEach(f => f()); }, 0); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    send(d) { const m = JSON.parse(d); if (m.id) setTimeout(() => (this.l.message || []).forEach(f => f({ data: JSON.stringify({ id: m.id, result: {} }) })), 0); }
    close() { this.readyState = 3; } }
  let n = 0;
  const ro = await api.connect('tok', { WebSocketImpl: FakeWS, createId: () => `x${++n}` });
  await assert.rejects(ro.request('thread/resume', { threadId: 'a' }), /仅支持读取/);
  ro.close();
  const rw = await api.connect('tok', { WebSocketImpl: FakeWS, createId: () => `y${++n}`, allowMethods: ['thread/resume'] });
  assert.deepEqual(JSON.parse(JSON.stringify(await rw.request('thread/resume', { threadId: 'a' }))), {});
  rw.close();
});

test('另一种 Work 入口（codex_work_web）：只有 *-wm 模型名也算 Work，查找把 codex_work_web 根线程算进去', async () => {
  const T = '01a0ef4c-bac5-74f7-85ff-a997f9820deb';
  const conv = { current_node: 'a2', mapping: {
    u: { parent: null, message: { id: '4b1d6f2c-0000-4000-8000-4a5f7c06b14d', author: { role: 'user' }, create_time: 1790721181.5,
      content: { parts: ['根据这个规则回答问题'] }, metadata: {} } },
    a1: { parent: 'u', message: { author: { role: 'assistant' }, create_time: 1790721192, metadata: { model_slug: 'gpt-6.1-sol-wm', working_turn_id: '4ecb7fe0-31e3-4dd5-bbe9-d81afdd03b51' } } },
    a2: { parent: 'a1', message: { author: { role: 'assistant' }, create_time: 1790721241, metadata: { model_slug: 'gpt-6.1-sol-wm' } } } } };
  const ev = JSON.parse(JSON.stringify(api.conversationEvidence(conv)));
  assert.equal(ev.mode, 'work');
  assert.deepEqual(ev.workTimes, [1790721181.5], '本轮用户消息时刻作为 Work 锚点');
  const client = { close() {}, request: async (method, params) => {
    if (method === 'thread/list') return params.archived ? { data: [], nextCursor: null } : { nextCursor: null, data: [
      { id: T, originator: 'codex_work_web', parentThreadId: null, threadSource: 'user', createdAt: 1790721181 },
      { id: '01a0a12b-5043-7030-90f1-59c1cb70b41f', originator: 'codex_work_web', parentThreadId: null, threadSource: 'user', createdAt: 1789410371 }] };
    if (method === 'thread/items/list') return { nextCursor: null, data: [{ item: { type: 'userMessage',
      content: [{ type: 'text', text: params.threadId === T ? '根据这个规则回答问题' : '另一件事' }] } }] };
    throw new Error(`unexpected ${method}`);
  } };
  const r = await api.resolve(conv, 'tok', { client });
  assert.deepEqual(JSON.parse(JSON.stringify(r.candidates)).map(c => [c.threadId, c.matchedBy]), [[T, 'first-user-message']]);
});
