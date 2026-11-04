// Windsurf Next adapter
// 数据源: ~/.codeium/windsurf-next/cascade/<uuid>.pb —— 加密会话文件（与 Antigravity
// conversations/*.pb 同族）。复用 antigravity 的 daemon RPC + sidecar 机制：
//   Windsurf Next 运行时其 language-server daemon 同样提供
//   exa.language_server_pb.LanguageServerService JSON RPC，开着时 sync 自动解密回填，
//   解密结果按 agy-reader 契约写 <uuid>.trajectory.json sidecar（.pb 旁边），离线可读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, RETRY_LATER } from '../util.js';
import { fetchTrajectory, sidecarFor, writeSidecar, trajectoryToSession, mtimeOf } from './antigravity.js';

function cascadeDir() {
  return path.join(os.homedir(), '.codeium', 'windsurf-next', 'cascade');
}

export const windsurfNextAdapter = {
  id: 'windsurf-next',

  watchRoots() {
    const d = cascadeDir();
    return fs.existsSync(d) ? [d] : [];
  },

  discover() {
    const d = cascadeDir();
    if (!fs.existsSync(d)) return [];
    // .pb 与已解密 sidecar 都作为源
    const out = [...listFiles(d, '.pb'), ...listFiles(d, '.trajectory.json')];
    return out;
  },

  fingerprint,

  async parseFile(filePath) {
    if (/\.trajectory\.json$/i.test(filePath)) {
      let traj;
      try { traj = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
      return trajectoryToSession(traj);
    }
    if (/\.pb$/i.test(filePath)) {
      const sc = sidecarFor(filePath);
      const pbMtime = mtimeOf(filePath);
      if (fs.existsSync(sc) && mtimeOf(sc) >= pbMtime) return null; // sidecar 新鲜，由其自投
      let traj = await fetchTrajectory(path.basename(filePath, '.pb'));
      if (traj) {
        try { writeSidecar(sc, traj); } catch { /* 缓存写失败不影响本轮 */ }
      } else if (fs.existsSync(sc)) {
        try { traj = JSON.parse(fs.readFileSync(sc, 'utf8')); } catch { traj = null; }
      }
      if (!traj) return RETRY_LATER; // daemon 离线且无缓存：下轮重试
      return trajectoryToSession(traj);
    }
    return null;
  },
};
