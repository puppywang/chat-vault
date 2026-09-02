// FTS 中文支持：CJK 拆字索引 + 短语查询
// 索引时在每个 CJK 字符两侧加空格，使 unicode61 分词器按单字建 token；
// 查询时把中文词转成短语（相邻单字序列），任意长度中文子串均可命中。

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_GLOBAL = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g;

/** 文本 -> 索引文本（CJK 单字间插空格，英文保持原词） */
export function ftsPrepare(text) {
  if (!text) return '';
  return String(text).replace(CJK_GLOBAL, ' $1 ');
}

/**
 * 用户查询词 -> FTS5 MATCH 表达式。
 * - "引号短语"：连续匹配（不加前缀），如 "pixel 10" 只命中两词相邻的文本
 * - 裸 CJK 词：拆字转相邻短语（任意长度中文子串均可命中）
 * - 裸 ASCII 词：引号包裹 + 前缀匹配（git -> 命中 github 等）
 * - 裸纯数字词：精确匹配不加前缀（10* 会在数字密集的语料上展开成海量 token，拖垮查询）
 * 引号包裹是必须的：裸 token 中的 -、. 等会被 FTS5 误解析为列过滤等语法（如 my-hub -> no such column: hub）。
 * 例: "修复 搜索框" -> '"修 复" "搜 索 框"'   git rebase -> '"git"* "rebase"*'   "pixel 10" -> '"pixel 10"'
 */
export function ftsQuery(term) {
  if (!term) return '';
  const parts = [];
  const re = /"([^"]*)"|\S+/g;
  let m;
  while ((m = re.exec(String(term))) !== null) {
    if (m[1] !== undefined) {
      const phrase = ftsPrepare(m[1]).replace(/\s+/g, ' ').trim();
      if (phrase) parts.push('"' + phrase + '"');
      continue;
    }
    const safe = m[0].replace(/["^]/g, ' ').trim();
    if (!safe) continue;
    if (CJK_CHAR.test(safe)) {
      parts.push('"' + ftsPrepare(safe).trim() + '"');
    } else if (/^\d+$/.test(safe)) {
      parts.push('"' + safe + '"');
    } else {
      parts.push('"' + safe + '"*');
    }
  }
  return parts.join(' ');
}
