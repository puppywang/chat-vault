// Actual popup HTML/JS in a fresh headless Chrome profile, with synthetic extension APIs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chatvault-codex-popup-'));
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/popup.html') {
      const html = await fs.readFile(path.join(root, 'extensions/chatgpt-sync/popup.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html.replace('</head>', '<script src="/fixture.js"></script></head>'));
      return;
    }
    const filename = req.url === '/fixture.js' ? 'test/fixtures/chatgpt-codex-popup-browser.js'
      : req.url === '/popup.js' ? 'extensions/chatgpt-sync/popup.js' : null;
    if (!filename) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(await fs.readFile(path.join(root, filename)));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { stdout } = await promisify(execFile)(executable, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profile}`, '--virtual-time-budget=10000', '--dump-dom',
    `http://127.0.0.1:${server.address().port}/popup.html`],
  { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)?.[1];
  const json = encoded?.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
  const result = JSON.parse(json || '{}');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  server.close();
  const resolved = path.resolve(profile), temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatvault-codex-popup-')) throw new Error('unsafe_temp_path');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    .catch(error => console.warn('Temporary profile retained:', resolved, error.code));
}
