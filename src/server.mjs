// 本地记忆检索服务：只读打开一个 SQLite 记忆库，提供 /search /get /stats。
// 设计前提：库是活的（别的进程在写），这里只读，不建表、不写入。
// 启动：MEM_DB=/path/to/memories.sqlite3 node src/server.mjs
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildFtsIndex } from "./fts-index.mjs";
import { createHybrid } from "./hybrid.mjs";
import { expandQuery } from "./expand.mjs";

const DB = process.env.MEM_DB;
if (!DB) {
  console.error("MEM_DB is required: point it at a SQLite file with a `memories` table.");
  process.exit(2);
}
const PORT = Number(process.env.MEM_PORT || 3505);
const HOST = process.env.MEM_HOST || "127.0.0.1";
const TOKEN = process.env.MEM_TOKEN || "";

const db = new DatabaseSync(DB, { readOnly: true });

const stmt = {
  byId: db.prepare(
    "select id,kind,title,content,importance,source,observed_at,sensitive from memories where id = ?"
  ),
  stats: db.prepare("select count(*) n from memories where superseded_by is null"),
};

const likeStmt = db.prepare(
  "select id,kind,title,content,importance,source,observed_at,sensitive from memories " +
    "where superseded_by is null and (title like ? or content like ?) order by importance desc limit ?"
);
const dfStmt = db.prepare(
  "select count(*) n from memories where superseded_by is null and (title like ? or content like ?)"
);
const totalStmt = db.prepare("select count(*) n from memories where superseded_by is null");

const likeRows = (term, limit) => {
  const q = `%${term}%`;
  return likeStmt.all(q, q, limit);
};

// 文档频率（带缓存）：给查询词算 idf，常见词降权
const dfCache = new Map();
function dfOf(term) {
  if (dfCache.has(term)) return dfCache.get(term);
  const q = `%${term}%`;
  const n = dfStmt.get(q, q).n;
  if (dfCache.size < 4000) dfCache.set(term, n);
  return n;
}

// 把查询拆成检索单元：
// - 按空格/标点分段，短段整段保留（关键词、专名）
// - 长段用 Intl.Segmenter 分词，丢虚词和单字，按 idf 加权
const seg = new Intl.Segmenter("zh-CN", { granularity: "word" });
const STOP = new Set([
  "的", "了", "吗", "呢", "吧", "啊", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "这", "那", "这个", "那个", "什么", "怎么", "为什么", "什么时候", "是", "在", "有", "和",
  "就", "也", "都", "一个", "一下", "说的", "来着", "还是", "可以", "因为", "所以", "但是",
  "怎么说", "怎么说话", "那次", "那次是", "你是", "我跟你", "跟我说",
]);

let dfLookup = dfOf;
const weightOf = (df, N) => Math.pow(Math.log((N + 1) / (df + 1)), 1.2);
const normText = (s) => String(s || "").replace(/[\u200b-\u200d\ufeff]/g, "").normalize("NFKC");

function planOf(q) {
  const raw = normText(q)
    .split(/[\s,，、。？?！!；;：:]+/)
    .filter(Boolean)
    .slice(0, 6);
  const N = Math.max(totalStmt.get().n, 1);
  const byTerm = new Map();
  const add = (t, w, df) => {
    if (!df) return; // 库里没有的词只抬高分母，不参与打分
    const old = byTerm.get(t);
    if (!old || old.w < w) byTerm.set(t, { t, w, df });
  };
  for (const t of raw) {
    const term = t.slice(0, 24);
    const dfTerm = dfLookup(term);
    if (term.length <= 4) add(term, weightOf(dfTerm, N), dfTerm);
    if (term.length >= 3) {
      const singles = [];
      for (const s of seg.segment(term)) {
        if (!s.isWordLike) continue;
        const w = s.segment.trim();
        if (w.length === 1 && /[\u4e00-\u9fff]/.test(w)) {
          singles.push(w);
          continue;
        }
        // 连续单字多半是词典没收录的专名，取相邻两字补一个锚点
        if (singles.length >= 2 && /[\u4e00-\u9fff]/.test(w)) {
          for (let i = 0; i + 1 < singles.length; i += 1) {
            const g = singles[i] + singles[i + 1];
            const df = dfOf(g);
            if (df > 0 && df / N <= 0.02) add(g, weightOf(df, N), df);
          }
        }
        singles.length = 0;
        if (w.length < 2 || STOP.has(w) || w === term) continue;
        const dfw = dfLookup(w);
        add(w, weightOf(dfw, N), dfw);
      }
    }
  }
  const units = [...byTerm.values()];
  const rarest = units.reduce((a, b) => (b.df < a.df ? b : a), units[0]);
  if (rarest) rarest.w *= 1.6; // 最稀有的词通常是句子重心
  return units;
}

function score(row, units) {
  const title = (row.title || "").toLowerCase();
  const content = (row.content || "").toLowerCase();
  let rel = 0;
  let hit = 0;
  const total = units.reduce((n, u) => n + u.w, 0);
  for (const u of units) {
    const t = u.t.toLowerCase();
    let h = 0;
    if (title.includes(t)) h += 1.6;
    h += Math.min(content.split(t).length - 1, 3) * 0.5;
    if (h > 0) {
      hit += 1;
      rel += h * u.w;
    }
  }
  if (!hit) return 0;
  const cov = rel / Math.max(total, 1);
  return cov * 12 + (hit >= 2 ? 1 : 0) + (Number(row.importance || 0) - 0.43) * 6 + recency(row) * 0.3;
}

function recency(row) {
  const at = Date.parse(row.observed_at || "");
  if (Number.isNaN(at)) return 0;
  const days = (Date.now() - at) / 86400000;
  return Math.max(0, 3 - days / 120);
}

let candidateRows = (units) => {
  const out = [];
  for (const u of units) out.push(...likeRows(u.t, 80));
  return out;
};

let fts = null;
if (process.env.MEM_FTS !== "0") {
  fts = buildFtsIndex(db);
  dfLookup = (term) => fts.dfOf(term);
  candidateRows = (units) => fts.candidates(units);
  console.log(
    `[memory-api] FTS index: ${fts.rows} rows, build ${fts.buildMs.toFixed(0)}ms, ${fts.memMB.toFixed(1)}MB`
  );
}

let hybrid = null;
if (process.env.MEM_HYBRID !== "0" && process.env.MEM_MODEL_DIR) {
  try {
    hybrid = await createHybrid(db, { modelDir: process.env.MEM_MODEL_DIR });
    console.log(
      `[memory-api] hybrid: ${hybrid.rows} vectors, dim ${hybrid.dim}, load ${hybrid.loadMs}ms`
    );
  } catch (e) {
    hybrid = null;
    console.error(`[memory-api] hybrid off: ${e.message}`);
  }
}

if (fts) {
  const everyMs = Number(process.env.MEM_FTS_REFRESH_MS || 60000);
  const timer = setInterval(() => {
    try {
      const n = stmt.stats.get().n;
      if (n !== fts.rows) {
        let synced = null;
        try {
          synced = fts.sync();
        } catch (e) {
          console.error(`[memory-api] FTS sync failed, rebuild: ${e.message}`);
        }
        if (!synced || synced.added + synced.removed > 2000) {
          fts = buildFtsIndex(db);
          console.log(`[memory-api] FTS rebuilt: ${fts.rows} rows, ${fts.buildMs.toFixed(0)}ms`);
        } else {
          fts.rows = synced.rows;
          console.log(
            `[memory-api] FTS synced: +${synced.added} -${synced.removed} rows=${synced.rows} ${synced.syncMs.toFixed(1)}ms`
          );
        }
      }
      if (hybrid && hybrid.refresh()) {
        console.log(`[memory-api] vectors refreshed: ${hybrid.rows} rows`);
      }
    } catch (e) {
      console.error(`[memory-api] FTS refresh failed: ${e.message}`);
    }
  }, everyMs);
  timer.unref?.();
}

function lexicalSearch(q, limit = 5) {
  const units = planOf(q);
  if (!units.length) return [];
  const seen = new Map();
  for (const row of candidateRows(units)) seen.set(row.id, row);
  return [...seen.values()]
    .map((r) => ({ r, s: score(r, units) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r, s }) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      content: r.content?.slice(0, 1200) ?? "",
      importance: r.importance,
      source: r.source,
      observed_at: r.observed_at,
      sensitive: !!r.sensitive,
      score: Math.round(s * 100) / 100,
    }));
}

const clampLimit = (n) => Math.max(1, Math.min(20, Number(n) || 5));
const search = (q, limit = 5) => lexicalSearch(q, clampLimit(limit));

async function searchCore(q, limit = 5) {
  limit = clampLimit(limit);
  q = normText(q);
  const lex = lexicalSearch(q, 50);
  if (!hybrid || !lex.length) return lex.slice(0, limit);
  // 词法已经很有把握时不再掺向量，保住关键词检索的锐度
  const gate = Number(process.env.MEM_HYBRID_GATE || 30);
  if (lex[0].score >= gate) return lex.slice(0, limit);
  let sem;
  try {
    sem = await hybrid.rank(q, 50);
  } catch (e) {
    console.error(`[memory-api] hybrid rank failed: ${e.message}`);
    return lex.slice(0, limit);
  }
  const byId = new Map(lex.map((r) => [r.id, r]));
  const fused = hybrid.fuse(
    lex.map((r) => r.id),
    sem.map((x) => x.id),
    (id) => byId.get(id)?.importance
  );
  const out = [];
  for (const { id, s } of fused) {
    if (out.length >= limit) break;
    let row = byId.get(id);
    if (!row) {
      const r = stmt.byId.get(id);
      if (!r) continue;
      row = { ...r, content: r.content?.slice(0, 1200) ?? "", sensitive: !!r.sensitive };
    }
    out.push({ ...row, score: Math.round(s * 100000) / 100 });
  }
  return out;
}

async function searchAsync(q, limit = 5) {
  const n = clampLimit(limit);
  const query = process.env.MEM_EXPAND === "1" ? expandQuery(q) : q;
  return searchCore(query, n);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (TOKEN && req.headers["x-mem-token"] !== TOKEN) {
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    return;
  }
  const send = (code, obj) =>
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(obj, null, 1));
  try {
    if (url.pathname === "/stats")
      return send(200, {
        total: stmt.stats.get().n,
        db: DB,
        fts: fts ? { rows: fts.rows, buildMs: Math.round(fts.buildMs) } : null,
        hybrid: hybrid ? { rows: hybrid.rows, dim: hybrid.dim, loadMs: hybrid.loadMs } : null,
      });
    if (url.pathname === "/get") {
      const row = stmt.byId.get(url.searchParams.get("id"));
      return row ? send(200, row) : send(404, { error: "not found" });
    }
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(Number(url.searchParams.get("limit") || 5), 20);
      return send(200, { q, results: await searchAsync(q, limit) });
    }
    return send(404, { error: "use /search?q= /get?id= /stats" });
  } catch (e) {
    return send(500, { error: String(e?.message || e) });
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, HOST, () => console.log(`memory-api listening ${HOST}:${PORT} db=${DB}`));
}

export { search, searchAsync, planOf };
