import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dir = new URL('../extensions/chatgpt-sync/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, dir), 'utf8');

test('页面脚本的版本取自扩展清单，不再写死（升级漏改会让弹窗一直提示「请刷新此标签页」）', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const context = vm.createContext({ chrome: { runtime: { getManifest: () => manifest },
    storage: { local: { get: async d => d }, onChanged: { addListener() {} } } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, window: { postMessage() {} }, document: {}, console,
    location: { origin: 'https://chatgpt.com', pathname: '/' } });
  context.globalThis = context;
  vm.runInContext(read('page-state.js'), context);
  assert.equal(context.__cvPage.version, manifest.version);
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(read(name), /version[^\n]{0,40}['"]\d+\.\d+\.\d+['"]/i, `${name} 里不应写死版本号`);
  }
});
