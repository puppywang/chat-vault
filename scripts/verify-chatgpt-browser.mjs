// Standalone headless Chrome, synthetic page; never opens the user's profile/database.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chatvault-browser-test-'));
const files = ['page-state', 'conversation-merge', 'page-conversation', 'dots', 'dots-title', 'diagnostics', 'speed', 'turns', 'codex-thread', 'codex-association', 'content'];
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/c/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>fixture</title></head><body><pre id="result">pending</pre>
        <script src="/setup.js"></script>${files.map(name => `<script src="/${name}.js"></script>`).join('')}
        <script src="/check.js"></script></body></html>`);
    } else {
      const name = req.url.slice(1).replace(/\.js$/, '');
      const filename = name === 'setup' || name === 'check'
        ? `test/fixtures/chatgpt-browser-${name}.js` : files.includes(name) ? `extensions/chatgpt-sync/${name}.js` : null;
      if (!filename) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(await fs.readFile(path.join(root, filename)));
    }
  } catch (err) { res.writeHead(500); res.end(err.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { stdout } = await promisify(execFile)(executable, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profile}`, '--virtual-time-budget=15000', '--dump-dom',
    `http://127.0.0.1:${server.address().port}/c/11111111-1111-1111-1111-111111111111${process.argv.includes('--staged-history') ? '?staged=1' : ''}`],
  { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)?.[1];
  const json = encoded?.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
  const result = JSON.parse(json || '{}');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  server.close();
  // Only remove the unique directory this runner created under the OS temp dir.
  const resolved = path.resolve(profile), temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatvault-browser-test-')) throw new Error('unsafe_temp_path');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(err => console.warn('Temporary profile retained:', resolved, err.code));
}
