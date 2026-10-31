# Lessons from building this

These are the measurements that shaped the design, kept here because most of them are not in the FTS5 or RRF papers.

## Chinese tokenization

- `unicode61` indexes a run of Han characters as **one token**. `MATCH '天气'` returns 0 rows even when the text contains 天气 — it only matches when the whole run equals the query.
- `trigram` cannot match queries shorter than three characters. Two-character queries are the common case in Chinese, so trigram alone is not enough.
- Bigram indexing (`天气 气很 很好`) gives two-character recall. On a 1.07M-character corpus the index was 7.3 MB and queries took ~0.2 ms, versus 5.9 ms for `LIKE '%…%'`.
- `Intl.Segmenter('zh-CN', {granularity:'word'})` splits unknown proper nouns into single characters (小明 → 小 | 明). Adding adjacent bigrams as anchors for runs of single characters fixed that.

## Ranking

- Summing weighted hits without normalizing favors long queries. Divide by the total unit weight (coverage) instead.
- Drop units with `df = 0`: a term that appears nowhere is not evidence, and it inflates the denominator.
- `importance` in many hand-built stores is 0..1, not 0..5. A term like `(importance - 3) * 0.5` is a constant offset and does nothing. Check the distribution first.
- RRF (`1/(60+rank)`) is robust to scale differences but prefers items both lists rank moderately well. A short, generic message can outrank the single best answer. A confidence gate ("if lexical top1 ≥ threshold, skip fusion") preserved exact-keyword queries; a rank-based weighting did not help.

## Index lifecycle

- Rebuilding a bigram index for 5.4k rows took ~1.1 s; an incremental diff (50 added, 20 removed) took 29 ms. Sync by id set difference, rebuild only when the delta is huge.
- The FTS index lives in `:memory:`. The table stays the source of truth; the index is disposable.

## SQLite details that bite

- `VACUUM INTO` is the safe way to copy a live database. Copying only the `.sqlite3` file while a WAL exists can silently lose committed rows.
- `wal_checkpoint(PASSIVE/FULL)` writes pages back but does not shrink the WAL. `TRUNCATE` needs no reader holding an old snapshot; one open read transaction returns `busy=1` and the file stays.
- Autocommit inserts are ~30× slower than batched transactions in WAL mode because each commit fsyncs.

## What we did not do

- ANN (IVF) at 5k vectors: nprobe=8 recalled 70% for a 1.3 ms saving — not worth the complexity.
- Filtering "assistant" messages: they are both pollution and content; removing them lost as many answers as it gained.
- Topic-level dedupe: the noise was many independent short messages, not duplicates of one another.
