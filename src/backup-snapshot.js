// Copy the authoritative tables directly; never materialize then vacuum away FTS.
// The source is opened read-only and pinned by one read transaction (including WAL).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ident = (name) => `"${name.replace(/"/g, '""')}"`;
const qualify = (sql) => sql.replace(/^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?)/i, '$1snapshot.');

export function createDataSnapshot(source, destination, { onTable = () => {} } = {}) {
  if (fs.existsSync(destination)) throw new Error('快照目标已存在，拒绝覆盖');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const db = new DatabaseSync(':memory:', { timeout: 60000 });
  let committed = false;
  try {
    db.prepare('ATTACH DATABASE ? AS source').run(`${pathToFileURL(path.resolve(source)).href}?mode=ro`);
    db.prepare('ATTACH DATABASE ? AS snapshot').run(destination);
    db.exec('PRAGMA snapshot.journal_mode=DELETE; PRAGMA snapshot.synchronous=FULL; PRAGMA snapshot.cache_size=-65536; PRAGMA temp_store=MEMORY; BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM source.sqlite_schema ORDER BY rowid').all();
    const tableTypes = new Map(db.prepare('PRAGMA source.table_list').all().map(t => [t.name, t.type]));
    const derived = new Set(['messages_fts']);
    for (const [name, type] of tableTypes) {
      if (type === 'shadow' && name.startsWith('messages_fts_')) derived.add(name);
      else if (type === 'virtual' && name !== 'messages_fts') throw new Error(`快照遇到未支持的虚表：${name}`);
    }
    const tables = schema.filter(o => o.type === 'table' && !o.name.startsWith('sqlite_') && !derived.has(o.name));
    const counts = {};
    for (const name of ['sessions', 'messages', 'workspaces', 'session_links']) {
      counts[name === 'session_links' ? 'links' : name] = tables.some(t => t.name === name)
        ? db.prepare(`SELECT count(*) n FROM source.${ident(name)}`).get().n : 0;
    }
    const lastUpdatedAt = db.prepare('SELECT max(updated_at) value FROM source.sessions').get().value ?? null;
    for (const table of tables) {
      db.exec(qualify(table.sql));
      const columns = db.prepare("SELECT name,type,pk,hidden FROM pragma_table_xinfo(?, 'source')").all(table.name).filter(c => c.hidden === 0);
      const pk = columns.filter(c => c.pk);
      const hasIntegerPk = pk.length === 1 && pk[0].type.toUpperCase() === 'INTEGER'
        && !db.prepare("SELECT 1 FROM pragma_index_list(?, 'source') WHERE origin='pk'").get(table.name);
      const names = columns.map(c => ident(c.name));
      // Preserve implicit rowids too; external references must not be renumbered.
      if (!hasIntegerPk && !/WITHOUT\s+ROWID/i.test(table.sql)) {
        const alias = ['rowid', '_rowid_', 'oid'].find(n => !columns.some(c => c.name.toLowerCase() === n));
        if (!alias) throw new Error(`快照无法保存隐式 rowid：${table.name}`);
        names.unshift(ident(alias));
      }
      db.exec(`INSERT INTO snapshot.${ident(table.name)} (${names.join(',')}) SELECT ${names.join(',')} FROM source.${ident(table.name)}`);
      onTable(table.name);
    }
    if (schema.some(o => o.name === 'sqlite_sequence')) {
      db.exec('DELETE FROM snapshot.sqlite_sequence; INSERT INTO snapshot.sqlite_sequence SELECT * FROM source.sqlite_sequence');
    }
    for (const item of schema.filter(o => ['index', 'view', 'trigger'].includes(o.type) && o.sql && !derived.has(o.tbl_name))) {
      if (/\bmessages_fts\b/i.test(item.sql)) throw new Error(`快照发现依赖全文索引的对象：${item.name}`);
      db.exec(qualify(item.sql));
    }
    for (const pragma of ['user_version', 'application_id']) {
      const value = Object.values(db.prepare(`PRAGMA source.${pragma}`).get())[0];
      db.exec(`PRAGMA snapshot.${pragma}=${value}`);
    }
    db.exec('COMMIT');
    committed = true;
    return { baseline: { ...counts, lastUpdatedAt }, ftsDropped: derived.has('messages_fts') && tableTypes.has('messages_fts') };
  } finally {
    if (!committed) { try { db.exec('ROLLBACK'); } catch { /* no transaction */ } }
    db.close();
    // An interrupted/failed output must never be mistaken for a valid snapshot.
    if (!committed && fs.existsSync(destination)) fs.unlinkSync(destination);
  }
}
