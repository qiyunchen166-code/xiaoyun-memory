// 测试用：临时建一个库，再按需加载 server（每次新 import，避免模块级状态串味）
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROWS = [
  ["m001", "explicit_fact", "用户：我不吃香菜", "用户明确说过不吃香菜，点外卖要注意。", 0.8],
  ["m002", "explicit_fact", "用户：生日是 3 月 12 日", "用户生日 3 月 12 日。", 0.9],
  ["m003", "profile_note", "用户养了一只猫", "猫叫团子，三岁，怕生。", 0.7],
  ["m004", "explicit_fact", "用户小时候摔断过手", "小学四年级从单杠上摔下来，右手骨折。", 0.75],
  ["m005", "preference", "用户喜欢喝冰红茶", "夏天常买冰红茶，不太喝咖啡。", 0.6],
  ["m006", "explicit_fact", "用户在一班", "高三一班，班主任姓李。", 0.65],
  ["m007", "explicit_fact", "用户对花粉过敏", "春天出门要戴口罩。", 0.6],
];

export function makeDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-")), "mem.sqlite3");
  const db = new DatabaseSync(file);
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
  for (const [id, kind, title, content, importance] of ROWS) {
    ins.run(id, kind, title, content, importance, "test", "2026-10-01T00:00:00Z");
  }
  db.close();
  return file;
}

export async function loadServer(dbFile) {
  process.env.MEM_DB = dbFile;
  process.env.MEM_FTS = "1";
  process.env.MEM_HYBRID = "0";
  return import(`../src/server.mjs?t=${Date.now()}-${Math.random()}`);
}
