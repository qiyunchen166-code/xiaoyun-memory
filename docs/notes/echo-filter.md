# The top hit is usually the question itself

When a chat scraper writes every message into the same table you search, asking a question a second time returns that question — it is the closest text in the corpus.

Measured on a real 5,400-row memory table (200 questions, 6–40 chars):

| metric | value |
| --- | --- |
| top1 is the question's own row | 160 / 200 (80%) |
| top1 is an assistant reply | 21 / 200 (10.5%) |
| top1 is a curated fact | 8 / 200 |

A top1 metric computed on such a table is mostly measuring "did we archive the question", not "did we answer it".

## Filter

`searchCore` drops rows before ranking when all of these hold:

- query is at least 8 characters,
- row `kind` ends with `_user`,
- row content contains the entire normalized query.

If everything is dropped, it returns the unfiltered rows — a filter must never turn an answer into an empty result.

Same 200 questions afterwards: 129 self-hits (down from 160). The remainder are not duplicates; they are other messages from the same conversation that quote the question. Removing those needs conversation-level grouping, which costs more than it returns at this size.

Disable with `MEM_ECHO_FILTER=0`.

## Test

`test/echo.test.mjs` seeds a question row plus one answer row, then asserts:

- default: the question row is not first;
- `MEM_ECHO_FILTER=0`: the question row is first again.

The fallback is exercised by the first test only if a second row exists — with a single row the filter deliberately returns it.
