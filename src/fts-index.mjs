// 内存 bigram FTS 索引：给 memory-api 的整句检索做候选召回和 df 统计
// 只读：从已打开的 srcDb 里读行，索引建在 :memory:，不碰原库
import { DatabaseSync } from "node:sqlite";

export function bigrams(text) {
  const s = String(text || "")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  const out = [];
  for (const chunk of s.split(" ")) {
    const chars = [...chunk];
    if (chars.length === 1) out.push(chars[0]);
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out.join(" ");
}

function phrase(term) {
  const parts = bigrams(term).split(" ").filter(Boolean);
  return '"' + parts.join(" ") + '"';
}

export function buildFtsIndex(srcDb) {
  const t0 = performance.now();
  const mem = new DatabaseSync(":memory:");
  const rows = srcDb
    .prepare("select id,kind,title,content,importance,source,observed_at,sensitive from memories where superseded_by is null")
    .all();

  mem.exec(
    "create table docs(rowid integer primary key, id text, kind text, title text, content text, importance real, source text, observed_at text, sensitive integer)"
  );
  mem.exec("create virtual table ft using fts5(body, tokenize='unicode61')");
  const insDoc = mem.prepare("insert into docs values(?,?,?,?,?,?,?,?,?)");
  const insFts = mem.prepare("insert into ft(rowid, body) values(?,?)");
  const idToRowid = new Map();
  let nextRowid = 1;
  const addRow = (r) => {
    const rowid = nextRowid++;
    insDoc.run(rowid, r.id, r.kind, r.title, r.content, r.importance, r.source, r.observed_at, r.sensitive ? 1 : 0);
    insFts.run(rowid, bigrams(`${r.title || ""} ${r.content || ""}`));
    idToRowid.set(r.id, rowid);
  };
  rows.forEach(addRow);

  const dfStmt = mem.prepare("select count(*) n from ft where ft match ?");
  const cache = new Map();
  function dfOf(term) {
    if (cache.has(term)) return cache.get(term);
    let n = 0;
    try {
      n = dfStmt.get(phrase(term)).n;
    } catch {
      n = 0;
    }
    if (cache.size < 20000) cache.set(term, n);
    return n;
  }

  const candStmt = mem.prepare(
    "select d.id, d.kind, d.title, d.content, d.importance, d.source, d.observed_at, d.sensitive " +
      "from ft join docs d on d.rowid = ft.rowid where ft match ? order by bm25(ft) limit 400"
  );
  function candidates(units) {
    const parts = units.flatMap((u) => bigrams(u.t).split(" ")).filter(Boolean);
    const q = [...new Set(parts)].map((t) => '"' + t + '"').join(" OR ");
    if (!q) return [];
    return candStmt.all(q);
  }

  const buildMs = performance.now() - t0;
  const memMB = (mem.prepare("pragma page_count").get().page_count * 4096) / 1048576;

  const selOne = srcDb.prepare(
    "select id,kind,title,content,importance,source,observed_at,sensitive from memories where id = ? and superseded_by is null"
  );
  const validIds = srcDb.prepare("select id from memories where superseded_by is null");
  const delDoc = mem.prepare("delete from docs where rowid = ?");
  const delFts = mem.prepare("delete from ft where rowid = ?");

  // 增量同步：只插入新增、删除失效，不重建索引
  function sync() {
    const t = performance.now();
    const now = new Set(validIds.all().map((r) => r.id));
    let added = 0;
    let removed = 0;
    for (const id of idToRowid.keys()) {
      if (!now.has(id)) {
        const rowid = idToRowid.get(id);
        delFts.run(rowid);
        delDoc.run(rowid);
        idToRowid.delete(id);
        removed += 1;
      }
    }
    for (const id of now) {
      if (idToRowid.has(id)) continue;
      const r = selOne.get(id);
      if (r) {
        addRow(r);
        added += 1;
      }
    }
    if (added || removed) cache.clear();
    return { added, removed, rows: idToRowid.size, syncMs: performance.now() - t };
  }

  return { dfOf, candidates, rows: rows.length, buildMs, memMB, mem, sync };
}
