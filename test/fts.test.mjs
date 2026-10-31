import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeDb } from "./helpers.mjs";
import { buildFtsIndex } from "../src/fts-index.mjs";

const db = new DatabaseSync(makeDb());
const fts = buildFtsIndex(db);

test("索引行数与库一致", () => {
  assert.equal(fts.rows, 7);
  assert.ok(fts.memMB > 0);
});

test("df 能数到具体词", () => {
  assert.ok(fts.dfOf("香菜") >= 1);
  assert.equal(fts.dfOf("不存在的词"), 0);
});

test("候选召回含目标行", () => {
  const rows = fts.candidates([{ t: "香菜" }]);
  assert.ok(rows.some((r) => r.id === "m001"));
});

test("增量 sync 只加新增", () => {
  db.prepare("insert into memories(id,kind,title,content) values(?,?,?,?)").run(
    "m008",
    "explicit_fact",
    "用户学过钢琴",
    "最近在练钢琴，喜欢肖邦。"
  );
  const r = fts.sync();
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
  assert.equal(r.rows, 8);
  assert.ok(fts.dfOf("钢琴") >= 1);
});
