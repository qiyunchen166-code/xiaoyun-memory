// 查询扩展：把口语里的词换成记忆库里真会出现的词。默认关闭，MEM_EXPAND=1 才启用。
// 规则放 JSON，改规则不用改代码：MEM_EXPAND_FILE=./config/expand.example.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MEM_EXPAND_FILE || path.join(HERE, "..", "config", "expand.example.json");

let rules = [];
try {
  rules = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`[memory-api] expand rules not loaded: ${e.message}`);
}

export function expandQuery(q) {
  const add = [];
  for (const r of rules) {
    if (r.match?.some((w) => q.includes(w))) add.push(...(r.add || []));
  }
  if (!add.length) return q;
  return q + " " + [...new Set(add)].join(" ");
}

export function expandRules() {
  return rules;
}
