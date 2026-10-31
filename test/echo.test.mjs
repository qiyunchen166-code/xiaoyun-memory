// 归档库里的问句自己会抢第一；这条测试锁住回声过滤的默认行为。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeDb, loadServer } from "./helpers.mjs";

function seedEchoRow(dbFile) {
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare(
    "insert into memories(id,kind,title,content,importance,source,observed_at) values(?,?,?,?,?,?,?)"
  );
  ins.run(
    "echo1",
    "chat_user",
    "用户：我昨天说的那件事",
    "用户：我昨天说的那件事你还记得吗",
    0.5,
    "test",
    "2026-10-02T00:00:00Z"
  );
  ins.run(
    "answer1",
    "explicit_fact",
    "那件事的答案",
    "昨天说的那件事，是去年秋天搬家的日子。",
    0.6,
    "test",
    "2026-10-02T00:00:00Z"
  );
  db.close();
}

test("回声过滤：问句自己不当第一", async () => {
  const dbFile = makeDb();
  seedEchoRow(dbFile);
  delete process.env.MEM_ECHO_FILTER;
  const s = await loadServer(dbFile);
  const out = await s.searchAsync("我昨天说的那件事你还记得吗", 3);
  assert.notEqual(out[0].id, "echo1");
});

test("MEM_ECHO_FILTER=0 时保留原行为", async () => {
  const dbFile = makeDb();
  seedEchoRow(dbFile);
  process.env.MEM_ECHO_FILTER = "0";
  const s = await loadServer(dbFile);
  const out = await s.searchAsync("我昨天说的那件事你还记得吗", 3);
  assert.equal(out[0].id, "echo1");
  delete process.env.MEM_ECHO_FILTER;
});
