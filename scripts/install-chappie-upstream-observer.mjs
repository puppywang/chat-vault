// Explicit installer for the inspected local Chappie patch, no restart or credential/config edits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), flag = args.indexOf('--chappie-dir');
if (flag < 0 || !args[flag + 1]) throw new Error('--chappie-dir is required');
const root = path.resolve(args[flag + 1]);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Local fork line only (branch patch/pi-only on v0.5.0); upstream 1.x rewrote server.ts. The anchor check below guards each patch.N.
if (pkg.name !== '@zetaloop/chappie' || !/^0\.5\.1-patch\.\d+$/.test(pkg.version)) throw new Error('unsupported_chappie_version');
const server = path.join(root, 'src/server.ts');
const before = fs.readFileSync(server, 'utf8');
const marker = 'import { observeUpstreamMeta } from "./codex-upstream-observer.js";';
const matches = before.match(/\t\t\trequireChatId\(context\);\r?\n\t\t\tcontext.mcpReq.signal.throwIfAborted\(\);/g) || [];
const already = before.includes(marker);
if (!already && matches.length !== 1) throw new Error('request_wrapper_changed_no_patch_applied');
const line = matches[0], eol = line?.includes('\r\n') ? '\r\n' : '\n';
const after = already ? before : marker + eol + before.replace(line, line + eol + '\t\t\tobserveUpstreamMeta(context.mcpReq._meta);');
const observer = path.join(root, 'src/codex-upstream-observer.js');
const declaration = path.join(root, 'src/codex-upstream-observer.d.ts');
if (!already && (fs.existsSync(observer) || fs.existsSync(declaration))) throw new Error('observer_destination_already_exists');
const digest = text => createHash('sha256').update(text).digest('hex');
if (args.includes('--apply')) {
  if (already) throw new Error('already_installed_review_existing_files_before_updating');
  const backup = path.join(root, 'src/server.ts.before-codex-observer');
  if (fs.existsSync(backup)) throw new Error('backup_already_exists');
  fs.writeFileSync(backup, before, { flag: 'wx' });
  try {
    fs.copyFileSync(path.join(repo, 'src/codex-upstream-observer.js'), observer, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(repo, 'integrations/chappie/codex-upstream-observer.d.ts'), declaration, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(server, after);
    if (digest(fs.readFileSync(server)) !== digest(after)) throw new Error('server_hash_mismatch');
  } catch (error) { fs.writeFileSync(server, before); fs.rmSync(observer, { force: true }); fs.rmSync(declaration, { force: true }); throw error; }
}
console.log(JSON.stringify({ mode: args.includes('--apply') ? 'installed-on-disk' : 'check', package: pkg.version,
  already, beforeSha256: digest(before), afterSha256: digest(after), server,
  runtimeReloaded: false, activated: false, note: 'The currently running process is unchanged; activation requires a later Pi/Chappie reload.' }, null, 2));
