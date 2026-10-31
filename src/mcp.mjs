// MCP stdio 包装：把 memory-api 暴露成 memory_search / memory_get 两个工具。
// 环境变量：MEM_API（默认 http://127.0.0.1:3505）、MEM_TOKEN（可选）
import process from "node:process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.MEM_API || "http://127.0.0.1:3505";
const TOKEN = process.env.MEM_TOKEN || "";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(API);

// 懒启动：宿主拉起 MCP 时服务不一定在跑。首次调用前 ping，没起来就在本机拉一个（detached）。
let readyUntil = 0;
let starting = null;

async function ping(timeoutMs = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(API + "/stats", { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureServer() {
  if (Date.now() < readyUntil) return true;
  if (await ping()) {
    readyUntil = Date.now() + 5000;
    return true;
  }
  if (!LOCAL) return false;
  if (!starting) {
    starting = (async () => {
      try {
        const out = fs.openSync(path.join(HERE, "..", "server.out.log"), "a");
        const err = fs.openSync(path.join(HERE, "..", "server.err.log"), "a");
        const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
          cwd: path.join(HERE, ".."),
          detached: true,
          windowsHide: true,
          stdio: ["ignore", out, err],
          env: { ...process.env },
        });
        child.unref();
      } catch {
        // 起不来就让下面的轮询失败，调用方会收到错误
      }
      for (let i = 0; i < 40; i += 1) {
        if (await ping(500)) {
          readyUntil = Date.now() + 5000;
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })().finally(() => {
      starting = null;
    });
  }
  await starting;
  return Date.now() < readyUntil;
}

const TOOLS = [
  {
    name: "memory_search",
    description: "查本地长期记忆库（只读）。用关键词找过去的事、偏好、约定。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，空格分隔多个词" },
        limit: { type: "number", description: "返回条数，默认 5，最多 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "按 id 取一条记忆的完整内容。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

async function call(ep, params) {
  const u = new URL(API + ep);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: TOKEN ? { "x-mem-token": TOKEN } : {} });
  if (!res.ok) throw new Error(`memory-api ${res.status}`);
  return res.json();
}

// 服务可能中途被杀：第一次 fetch 失败就把 readiness 归零、重拉一次再试。
async function callEnsured(ep, params) {
  try {
    await ensureServer();
    return await call(ep, params);
  } catch (e) {
    if (e instanceof TypeError || /fetch failed/.test(String(e?.message))) {
      readyUntil = 0;
      await ensureServer();
      return await call(ep, params);
    }
    throw e;
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function error(id, code, message) {
  if (id === undefined || id === null) return; // 通知没有 id，不回复
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        reply(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "memory-api", version: "1.0.0" },
        });
      } else if (method === "tools/list") {
        reply(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || {};
        if (name === "memory_search") {
          if (typeof args.query !== "string" || !args.query.trim()) {
            error(id, -32602, "missing required argument: query");
            return;
          }
          const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
          const data = await callEnsured("/search", { q: args.query.trim(), limit });
          reply(id, { content: [{ type: "text", text: JSON.stringify(data.results, null, 1) }] });
        } else if (name === "memory_get") {
          if (typeof args.id !== "string" || !args.id.trim()) {
            error(id, -32602, "missing required argument: id");
            return;
          }
          const data = await callEnsured("/get", { id: args.id.trim() });
          reply(id, { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
        } else {
          error(id, -32602, `unknown tool ${name}`);
        }
      } else if (method === "ping") {
        reply(id, {});
      } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
        // ignore
      } else {
        error(id, -32601, `unknown method ${method}`);
      }
    } catch (e) {
      error(id, -32000, String(e?.message || e));
    }
  }
});
