// 微基准：造一个几百行的库，跑一批中文查询，量 p50/p95。
// 用法：node bench/bench.mjs [rows]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROWS = Number(process.argv[2] || 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bench-"));
const dbFile = path.join(dir, "bench.sqlite3");

const topics = [
  ["explicit_fact", "用户不吃香菜", "点外卖的时候要备注不要香菜，火锅蘸料也不放。"],
  ["explicit_fact", "用户生日", "生日是三月十二日，每年都过农历。"],
  ["profile_note", "用户养猫", "猫叫团子，怕生，喜欢纸箱和窗台。"],
  ["preference", "用户喜欢安静", "不喜欢吵闹的商场，喜欢江边和书店。"],
  ["project_note", "检索项目", "用 SQLite FTS5 做中文检索，本地只读。"],
  ["explicit_fact", "用户学过吉他", "大学学过两年，会弹几首民谣。"],
  ["explicit_fact", "用户对花粉过敏", "春天出门戴口罩，家里不放鲜花。"],
  ["conversation_summary", "聊过搬家", "从城东搬到城西，书装了十二箱。"],
];

const db = new DatabaseSync(dbFile);
db.exec(`
  create table memories (
    id text primary key, kind text, title text, content text,
    importance real default 0.5, source text, observed_at text,
    sensitive integer default 0, superseded_by text
  );
  create table mem_vectors (id text primary key, vec blob);
`);
const ins = db.prepare(
  "insert into memories(id,kind,title,content,importance,source,observed_at) values(?,?,?,?,?,?,?)"
);
for (let i = 0; i < ROWS; i += 1) {
  const [kind, title, content] = topics[i % topics.length];
  ins.run(`b${i}`, kind, `${title} #${i}`, `${content} 这是第 ${i} 条。`, 0.5, "bench", "2026-10-01T00:00:00Z");
}
db.close();

process.env.MEM_DB = dbFile;
process.env.MEM_FTS = "1";
process.env.MEM_HYBRID = "0";
const srv = await import("../src/server.mjs");

const queries = ["香菜", "生日是哪天", "猫叫什么", "安静的地方", "检索项目", "吉他", "花粉过敏", "搬家", "火锅", "书店"];
const times = [];
for (let round = 0; round < 20; round += 1) {
  for (const q of queries) {
    const t = performance.now();
    await srv.searchAsync(q, 5);
    times.push(performance.now() - t);
  }
}
times.sort((a, b) => a - b);
const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
console.log(`rows=${ROWS} queries=${times.length}`);
console.log(`p50=${at(0.5).toFixed(2)}ms p95=${at(0.95).toFixed(2)}ms max=${times.at(-1).toFixed(2)}ms`);
