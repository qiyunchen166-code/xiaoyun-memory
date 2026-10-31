# Notes: FTS5 for Chinese, measured

All numbers below come from `node:sqlite` (SQLite 3.53.x) on Windows, Node 24.

## Tokenizers, one query at a time

A four-document toy corpus:

| query | `unicode61` | `trigram` | bigram (hand-built) |
| --- | --- | --- | --- |
| 天气 | 0 | 0 | hit |
| 海边 | 0 | 0 | hit |
| 全文检索 | 0 | 1 | hit |
| SQLite | 1 | 0 | hit |

- `unicode61` treats a run of Han characters as one token: only an exact whole-run match counts, and ASCII words match normally.
- `trigram` needs at least three characters — every two-character query returned 0.
- A token-prefix query (`'"全文"*'`) works under `unicode61` only when 全文 is a token prefix, which it usually is not in Chinese text.

## Bigram index size and speed

Corpus: 137 markdown files, 447,669 characters, 1,866 paragraphs, plain table 728 KB.

| index | size | ratio | 200 queries |
| --- | --- | --- | --- |
| `unicode61` | 1,712 KB | 2.35× | 15.2 ms |
| `trigram` | 5,160 KB | 7.09× | 22.7 ms |
| bigram | 2,200 KB | 3.02× | 12.1 ms |

On a real 5.4k-row memory table (1.07M characters): bigram index +7.3 MB, query 0.17–0.24 ms versus 5.9 ms for `LIKE '%…%'` — about 30×. Trigram matched 1 of 16 real two-character queries; bigram matched 15 of 16 with the same row counts as `LIKE`.

## Gotchas

- An external-content FTS table has no `id` column; select `rowid` or join the source table.
- `delete` + `insert` triggers work for updates, but an incremental `sync()` that diffs id sets is cheaper: 29 ms for +50/−20 versus 1.1 s for a full rebuild at 5.4k rows.
- `bm25()` returns smaller-is-better; do not mix it with a score where larger is better without normalizing.
- Rank overlap with a title/importance-weighted `LIKE` baseline ranged 15%–100% by query — FTS changes the order, so if you need the old ranking, re-rank on top of FTS candidates instead of trusting `bm25`.
