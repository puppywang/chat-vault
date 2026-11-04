// 工作区路径归一化：把各 agent 的路径表示统一成绝对 Windows 路径
// 支持: "d:\\WorkDemo\\x" | "file:///d%3A/WorkDemo/x" | "/d:/WorkDemo/x"

export function normalizeWorkspacePath(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  if (s.startsWith('file://')) {
    try {
      s = decodeURIComponent(new URL(s).pathname); // file:///d%3A/... -> /d:/...
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/\/+/, ''));
    }
  }
  // /d:/xxx -> d:\xxx
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  if (!/^[a-zA-Z]:[\\/]/.test(s) && !s.startsWith('\\\\')) return null; // 只接受盘符路径和 UNC

  s = s.replace(/\//g, '\\').replace(/\\+$/, '');
  s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// 用于唯一性比较的 key（大小写不敏感）
export function workspaceKey(normalizedPath) {
  return normalizedPath ? normalizedPath.toLowerCase() : null;
}

export function workspaceName(normalizedPath) {
  if (!normalizedPath) return null;
  const parts = normalizedPath.split('\\').filter(Boolean);
  return parts[parts.length - 1] || normalizedPath;
}
