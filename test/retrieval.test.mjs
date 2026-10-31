import test from "node:test";
import assert from "node:assert/strict";
import { makeDb, loadServer } from "./helpers.mjs";

const dbFile = makeDb();
const srv = await loadServer(dbFile);

test("关键词能查到对应记忆", async () => {
  const rows = await srv.searchAsync("香菜", 5);
  assert.ok(rows.length > 0);
  assert.match(rows[0].content, /香菜/);
});

test("自然句能查到生日", async () => {
  const rows = await srv.searchAsync("我的生日是哪天", 5);
  assert.ok(rows.some((r) => /3 月 12 日/.test(r.content)));
});

test("limit 被夹在 1..20", async () => {
  const rows = await srv.searchAsync("用户", 100);
  assert.ok(rows.length <= 20);
});

test("零宽字符不影响召回", async () => {
  const rows = await srv.searchAsync("生\u200b日", 5);
  assert.ok(rows.some((r) => /3 月 12 日/.test(r.content)));
});

test("同步接口返回数组且字段齐全", () => {
  const rows = srv.search("香菜", 3);
  assert.ok(Array.isArray(rows));
  for (const r of rows) {
    assert.ok(r.id && r.title !== undefined && r.content !== undefined);
  }
});
