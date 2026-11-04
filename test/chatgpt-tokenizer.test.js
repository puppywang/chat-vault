import assert from 'node:assert/strict';
import test from 'node:test';
import { countTexts } from '../extensions/chatgpt-sync/tokenizer.js';

test('o200k_base 分词器按完整消息计数，不按 SSE 分片猜字符数', () => {
  assert.equal(countTexts(['hello world']), 2);
  assert.equal(countTexts(['']), 0);
  assert.equal(countTexts(['hello', ' world']),
    countTexts(['hello']) + countTexts([' world']));
  assert.ok(Number.isInteger(countTexts(['你好，世界'])));
});
