// Codeium（Antigravity/Windsurf）系 trajectory 摘要的公共 protobuf wire 解析
// 最小 wire format 解析器（varint / length-delimited），字段按编号访问。

/** 解析 protobuf buffer → [{field, v} | {field, buf}]；结构异常时返回已解析部分 */
export function parsePb(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0, s = 0;
    while (true) {
      if (i >= buf.length) return out;
      const b = buf[i++]; tag |= (b & 0x7f) << s; s += 7;
      if (!(b & 0x80)) break;
    }
    const field = tag >>> 3, wt = tag & 7;
    if (field === 0) return out;
    if (wt === 0) {
      let v = 0n, s2 = 0n;
      while (true) {
        if (i >= buf.length) return out;
        const b = buf[i++]; v |= BigInt(b & 0x7f) << s2; s2 += 7n;
        if (!(b & 0x80)) break;
      }
      out.push({ field, v: Number(v) });
    } else if (wt === 2) {
      let len = 0, s3 = 0;
      while (true) {
        if (i >= buf.length) return out;
        const b = buf[i++]; len |= (b & 0x7f) << s3; s3 += 7;
        if (!(b & 0x80)) break;
      }
      if (i + len > buf.length) return out;
      out.push({ field, buf: buf.slice(i, i + len) });
      i += len;
    } else if (wt === 5) i += 4;
    else if (wt === 1) i += 8;
    else return out;
  }
  return out;
}

/** 取指定编号的第一个字段 */
export const f1 = (fields, n) => fields.find((f) => f.field === n);

/** protobuf Timestamp（F1: seconds）→ ISO 字符串 */
export const iso = (sec) => (typeof sec === 'number' && sec ? new Date(sec * 1000).toISOString() : null);
