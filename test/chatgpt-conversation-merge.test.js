import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import '../extensions/chatgpt-sync/conversation-merge.js';
import { parseConversation } from '../src/adapters/chatgpt.js';

const { branchToConversation, merge, signature } = globalThis.ChatVaultConversationMerge;
const ID = '6acf09d8-30c8-83ec-8142-87e0afe855be';
const msg = (id, role, text, parent, t, extra = {}) => ({ id, author: { role }, create_time: t, update_time: t,
  content: { content_type: 'text', parts: [text] }, metadata: parent ? { parent_id: parent } : {}, ...extra });
// 已归档的整棵树：root → u1 → a1 → u2 → a2
function archive() {
  const mapping = { root: { id: 'root', message: null, parent: null } };
  const chain = [msg('u1', 'user', '问题一', 'root', 1), msg('a1', 'assistant', '回答一', 'u1', 2),
    msg('u2', 'user', '问题二', 'a1', 3), msg('a2', 'assistant', '回答二', 'u2', 4)];
  for (const m of chain) mapping[m.id] = { id: m.id, message: m, parent: m.metadata.parent_id };
  return { conversation_id: ID, title: 't', update_time: 4, current_node: 'a2', mapping };
}
const page = (messages, { previous = true, current = messages.at(-1).id, update = 10 } = {}) => ({
  conversation_id: ID, update_time: update, current_node: current, messages,
  page_info: { has_previous_page: previous, has_next_page: false, start_cursor: messages[0].id, end_cursor: messages.at(-1).id } });
const texts = conv => parseConversation(conv, os.tmpdir()).messages.map(m => m.text);

test('最近几轮的分页并进已归档的树：更早的历史保留，新消息按 parent_id 接上', () => {
  const branch = branchToConversation(ID, page([msg('u2', 'user', '问题二', 'a1', 3), msg('a2', 'assistant', '回答二', 'u2', 4),
    msg('u3', 'user', '问题三', 'a2', 5), msg('a3', 'assistant', '回答三', 'u3', 6)]));
  const merged = merge(archive(), branch);
  assert.equal(merged.current_node, 'a3');
  assert.equal(merged.cv_partial, undefined, '能走到根');
  assert.equal(merged.cv_branch, undefined);
  assert.deepEqual(texts(merged), ['问题一', '回答一', '问题二', '回答二', '问题三', '回答三']);
});

test('往上翻读到的更早一页：不改变当前叶子', () => {
  const merged = merge(archive(), branchToConversation(ID, page([msg('u1', 'user', '问题一', 'root', 1),
    msg('a1', 'assistant', '回答一', 'u1', 2)], { current: 'a2', update: 4 })));
  assert.equal(merged.current_node, 'a2');
  assert.deepEqual(texts(merged), ['问题一', '回答一', '问题二', '回答二']);
});

test('同一条消息取较新的版本：流式中途的旧版本不覆盖已完成的版本', () => {
  const stale = msg('a2', 'assistant', '回答二（未完）', 'u2', 3.5);
  const merged = merge(archive(), branchToConversation(ID, page([stale], { update: 3.5 })));
  assert.deepEqual(texts(merged).slice(-1), ['回答二']);
  const fresh = msg('a2', 'assistant', '回答二（修订）', 'u2', 9);
  assert.deepEqual(texts(merge(archive(), branchToConversation(ID, page([fresh])))).slice(-1), ['回答二（修订）']);
});

test('拼不上：补空壳挂到旧叶子下，两头都保住；之后读到中间那段，真实节点顶替空壳', () => {
  // 页面只读到 u4 起的最近一段，u4 的父节点 a3 归档里没有
  const recent = branchToConversation(ID, page([msg('u4', 'user', '问题四', 'a3', 7), msg('a4', 'assistant', '回答四', 'u4', 8)]));
  const bridged = merge(archive(), recent);
  assert.equal(bridged.mapping.a3.cv_gap, true);
  assert.equal(bridged.mapping.a3.parent, 'a2');
  assert.deepEqual(texts(bridged), ['问题一', '回答一', '问题二', '回答二', '问题四', '回答四']);
  // 往上翻读到中间那段
  const middle = branchToConversation(ID, page([msg('u3', 'user', '问题三', 'a2', 5), msg('a3', 'assistant', '回答三', 'u3', 6)],
    { current: 'a4', update: 8 }));
  const filled = merge(bridged, middle);
  assert.equal(filled.mapping.a3.cv_gap, undefined);
  assert.equal(filled.current_node, 'a4');
  assert.equal(filled.cv_partial, undefined);
  assert.deepEqual(texts(filled), ['问题一', '回答一', '问题二', '回答二', '问题三', '回答三', '问题四', '回答四']);
});

test('第一次就只有分页：照写，标记不完整', () => {
  const merged = merge(null, branchToConversation(ID, page([msg('u3', 'user', '问题三', 'a2', 5), msg('a3', 'assistant', '回答三', 'u3', 6)])));
  assert.equal(merged.cv_partial, true);
  assert.deepEqual(texts(merged), ['问题三', '回答三']);
});

test('整棵树进来：与已有内容合并，签名随内容变化', () => {
  const base = archive();
  const same = merge(base, archive());
  assert.equal(signature(same), signature(merge(null, archive())));
  const grown = archive();
  grown.mapping.u3 = { id: 'u3', message: msg('u3', 'user', '问题三', 'a2', 5), parent: 'a2' };
  grown.current_node = 'u3'; grown.update_time = 5;
  assert.notEqual(signature(merge(base, grown)), signature(same));
  assert.equal(merge(base, grown).current_node, 'u3');
});
