import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = async args => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args,
      { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return stdout + stderr;
  } catch (err) { throw new Error(`${args.join(' ')}\n${err.stdout || ''}${err.stderr || err.message}`); }
};
const extension = path.join(root, 'extensions/chatgpt-sync');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
for (const name of ['page-state.js', 'turns.js', 'dots-title.js', 'codex-thread.js', 'codex-association.js', 'popup.js']) {
  const source = await fs.readFile(path.join(extension, name), 'utf8');
  // Page scripts now derive their version from the injected manifest owner.
  if (!source.includes('getManifest().version') && !source.includes('__cvPage?.version')
    && !source.includes(`'${manifest.version}'`)) throw new Error(`${name}: missing manifest-derived version`);
}
if (manifest.permissions.includes('debugger')) throw new Error('CDP belongs to Chrome Tabs; ChatVault must not request debugger');
const scripts = (await fs.readdir(extension)).filter(name => name.endsWith('.js'));
await Promise.all(scripts.map(name => run(['--check', path.join(extension, name)])));
console.log(`Syntax: ${scripts.length} scripts; version: ${manifest.version}`);
const tests = (await fs.readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.js'));
const result = await run(['--test', ...tests.map(name => path.join('test', name))]);
console.log(result.split('\n').filter(line => /^(ℹ|# (tests|pass|fail))/.test(line)).join('\n'));
console.log(await run(['scripts/verify-chatgpt-browser.mjs']));
console.log('Staged history hydration (old messages before active user message):');
console.log(await run(['scripts/verify-chatgpt-browser.mjs', '--staged-history']));
console.log('Codex popup (isolated Chrome profile):');
console.log(await run(['scripts/verify-chatgpt-codex-popup.mjs']));
console.log('Local gate passed. Live extension/profile acceptance is still required; this runner does not deploy or reload tabs.');
