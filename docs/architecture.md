# Architecture

```
client ──HTTP──▶ server.mjs ──▶ planOf(q) ──▶ candidates ──▶ score ──▶ rows
                      │            │              │
                      │            │              ├─ FTS bigram index (in-memory, refreshed)
                      │            │              └─ LIKE fallback (MEM_FTS=0)
                      │            └─ df lookup (idf)
                      └─ optional: vector rank + RRF (MEM_HYBRID=1)
```

## Query path

1. **Normalize** — NFKC, strip zero-width characters.
2. **Plan** — split on punctuation into at most six segments. For each segment:
   - segments longer than four characters are segmented with `Intl.Segmenter` (`zh-CN`, word granularity);
   - stop words and single-character tokens are dropped;
   - runs of single characters (proper nouns the dictionary doesn't know) get adjacent bigrams as anchors;
   - the rarest unit is weighted ×1.6.
3. **Recall** — every unit is looked up in the bigram FTS index (`match` over OR-ed bigrams), up to 400 candidates ranked by `bm25`.
4. **Score** — coverage of the query's units dominates, with small bonuses for title hits, multiple hits, importance and recency.
5. **Fuse (optional)** — a vector pass embeds the query, ranks stored vectors by cosine, and RRF combines the two rankings: `1/(60+rankLex) + 1/(60+rankVec) + 0.002·importance`.

## Why a bigram FTS index

`unicode61` on Chinese treats a whole run as one token, so two-character queries miss. `trigram` cannot match fewer than three characters. Bigrams give two-character recall and stay small:

| corpus | plain table | bigram index | query |
| --- | --- | --- | --- |
| 1.07M chars, 5.4k rows | 3.9 MB | +7.3 MB | 0.2 ms vs 5.9 ms `LIKE` |

The index lives in a `:memory:` database. The table remains the source of truth; the index is rebuilt at boot and then synced incrementally (a 50-add/20-remove sync took 29 ms vs 1.1 s for a full rebuild).

## Ranking choices

- **Coverage over raw counts.** Summing weighted hits favors long queries with many repeated words; dividing by the total unit weight keeps scores comparable across query lengths.
- **idf via df.** `weight = log((N+1)/(df+1))^1.2`. Terms that appear nowhere (`df = 0`) are dropped instead of being allowed to inflate the denominator.
- **A gate, not a blend.** If the lexical top1 is confident (≥30), return it and skip embedding. This protects exact-keyword queries and keeps p50 low; on a 30-question set the gate preserved the top1 while the fused path improved the rest.
- **RRF, not score addition.** Lexical and cosine scores are not on the same scale. Rank fusion avoids calibrating them, at the cost of favoring items both lists rank moderately well.

## Guards & failure modes

- Missing `MEM_DB` → exit 2 with a clear message.
- FTS build failure → logged, falls back to `LIKE`.
- Hybrid load failure → logged, lexical-only.
- Vector table empty → hybrid disabled.
- `limit` clamped to 20; response content truncated to 1200 characters.

## Costs (measured on a 5.4k-row personal corpus)

| configuration | RSS | 30-question top1 |
| --- | --- | --- |
| lexical only | ~101 MB | 17/30 |
| + vector recall | ~169 MB | 19/30 |
| + profile routing & expansion (private extension) | ~169 MB | 23/30 |

The vector path costs ~10 MB for vectors plus ~55 MB of ONNX runtime arena. If memory matters more than recall, leave `MEM_HYBRID=0`.

## Non-goals

ANN indexes (at 5k rows, IVF with nprobe=8 recalled 70% for a 1.3 ms saving — not worth it), multi-process sharding, and write paths. This is a read-only search layer; ingestion belongs to the caller.
