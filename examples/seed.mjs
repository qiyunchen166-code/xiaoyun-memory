// 生成一个演示库：demo.sqlite3
// 用法：node examples/seed.mjs [path]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] || path.join(import.meta.dirname, "demo.sqlite3");
if (fs.existsSync(out)) fs.rmSync(out);

const db = new DatabaseSync(out);
db.exec(`
  create table memories (
    id text primary key,
    kind text,
    title text,
    content text,
    importance real default 0.5,
    source text,
    observed_at text,
    sensitive integer default 0,
    superseded_by text
  );
  create table mem_vectors (id text primary key, vec blob);
`);

const rows = [
  ["m001", "explicit_fact", "用户：我不吃香菜", "用户明确说过不吃香菜，点外卖要注意。", 0.8, "chat", "2026-10-01T10:00:00Z"],
  ["m002", "explicit_fact", "用户：生日是 3 月 12 日", "用户生日 3 月 12 日，去年过的 25 岁。", 0.9, "chat", "2026-09-20T10:00:00Z"],
  ["m003", "profile_note", "用户养了一只猫", "猫叫团子，三岁，怕生，喜欢钻纸箱。", 0.7, "chat", "2026-08-11T10:00:00Z"],
  ["m004", "explicit_fact", "用户小时候摔断过手", "小学四年级从单杠上摔下来，右手骨折，打了石膏。", 0.75, "chat", "2026-07-02T10:00:00Z"],
  ["m005", "preference", "用户喜欢喝冰红茶", "夏天常买冰红茶，不太喝咖啡。", 0.6, "chat", "2026-10-05T10:00:00Z"],
  ["m006", "explicit_fact", "用户在一班", "高三一班，班主任姓李。", 0.65, "chat", "2026-09-01T10:00:00Z"],
  ["m007", "project_note", "在做一个小型检索项目", "用 SQLite FTS5 + 向量召回，本地跑，只读。", 0.7, "note", "2026-10-10T10:00:00Z"],
  ["m008", "explicit_fact", "用户睡觉很晚", "经常熬到凌晨两三点，早上起不来。", 0.55, "chat", "2026-10-12T10:00:00Z"],
  ["m009", "preference", "用户不喜欢太吵的地方", "喜欢安静的书店和江边。", 0.5, "chat", "2026-06-18T10:00:00Z"],
  ["m010", "explicit_fact", "用户学过两年吉他", "大学时学过，会弹几首民谣。", 0.5, "chat", "2026-05-09T10:00:00Z"],
  ["m011", "conversation_summary", "聊过一次搬家", "从城东搬到城西，书装了十二箱。", 0.4, "summary", "2026-04-21T10:00:00Z"],
  ["m012", "explicit_fact", "用户对花粉过敏", "春天出门要戴口罩。", 0.6, "chat", "2026-03-30T10:00:00Z"],
];

const ins = db.prepare(
  "insert into memories(id,kind,title,content,importance,source,observed_at) values(?,?,?,?,?,?,?)"
);
for (const r of rows) ins.run(...r);

console.log(`seeded ${rows.length} rows -> ${out}`);
