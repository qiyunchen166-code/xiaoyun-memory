# xiaoyun-memory

A small, local-first memory search service for Chinese text. It runs on Node's built-in `node:sqlite`, keeps everything on disk/in memory on your machine, and exposes three things:

- an HTTP API (`/search`, `/get`, `/stats`),
- a stdio MCP server (`memory_search`, `memory_get`) so an agent can call it as a tool,
- a tiny schema you can point at your own table.

It was extracted from a personal assistant's memory pipeline. The interesting part is not FTS5 or RRF (both are well documented) — it is the glue: bigram tokenization for Chinese, candidate recall by FTS, optional vector recall, rank fusion, and a set of small guards that keep latency predictable.

## Why bigram

SQLite's `unicode61` tokenizer treats a run of Chinese characters as one token, so `MATCH '天气'` finds nothing unless the whole run matches. `trigram` needs at least three characters. A bigram index (`天气 气很 很好 …`) gives two-character recall with a modest size cost: on a 1.07M-character corpus it was ~7.3 MB and answered in ~0.2 ms, roughly 30× faster than a `LIKE '%…%'` scan.

## Quick start

```bash
node examples/seed.mjs demo.sqlite3
MEM_DB=./demo.sqlite3 MEM_PORT=3505 node src/server.mjs
curl "http://127.0.0.1:3505/search?q=香菜&limit=3"
```

MCP:

```bash
MEM_API=http://127.0.0.1:3505 node src/mcp.mjs
```

The wrapper lazily starts `src/server.mjs` if the API is not up (local URLs only).

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/search?q=…&limit=5` | returns `{query, count, results:[{id,kind,title,content,importance,source,observed_at,sensitive,score}]}` |
| GET | `/get?id=…` | one row, `404` if missing |
| GET | `/stats` | `{total, db, fts, hybrid}` |

`limit` is clamped to 1..20. Query text is normalized (NFKC, zero-width characters removed) before tokenization.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEM_DB` | — (required) | path to the SQLite file |
| `MEM_PORT` / `MEM_HOST` | `3505` / `127.0.0.1` | HTTP listener |
| `MEM_TOKEN` | — | if set, require header `x-mem-token` |
| `MEM_FTS` | on | `0` disables the in-memory bigram index (falls back to `LIKE`) |
| `MEM_FTS_REFRESH_MS` | `60000` | how often to sync the index with the table |
| `MEM_HYBRID` | off | `1` enables vector recall + RRF |
| `MEM_MODEL_DIR` | — | directory with an ONNX export of a sentence-embedding model |
| `MEM_HYBRID_GATE` | `30` | if lexical top1 scores ≥ this, skip the vector pass |
| `MEM_EXPAND` | off | `1` enables query expansion rules |
| `MEM_EXPAND_FILE` | `config/expand.example.json` | JSON rule table |

## Schema

```sql
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
create table mem_vectors (id text primary key, vec blob); -- optional, float32 LE, 512-d
```

Rows with `superseded_by is not null` are ignored everywhere.

## Tests

```bash
npm test        # node --test test/retrieval.test.mjs test/fts.test.mjs
```

Tests build a throwaway database in the OS temp dir, so they never touch your data.

## What this is not

- Not a database. It reads an existing SQLite file; writes are your job.
- Not a hosted service. It binds to loopback by default.
- Not a model. Vector recall is optional and expects you to bring a model directory.

## License

MIT.
