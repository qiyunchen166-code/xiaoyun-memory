# Notes: vector recall + RRF, measured

A 30-question set built from a real personal memory store (5.4k rows, 1.07M characters). Each question has an expected substring; a hit means a top-k row contains it.

## Three retrievers

| mode | top1 | top3 | mean latency |
| --- | --- | --- | --- |
| lexical (bigram FTS + coverage score) | 17/30 | 20/30 | 4.8 ms |
| vector only (bge-small-zh, 512-d, cosine) | 12/30 | 14/30 | 11.6 ms |
| RRF fusion (1/(60+rank), +0.002·importance) | 19/30 | 22/30 | 16.5 ms |

Fusion wins but not by much, and it is not free: the embedding pass adds 10–13 ms per non-gated query and ~110 MB RSS (model arena + vectors).

## A confidence gate

If the lexical top1 scores ≥ 30 (a coverage-based score), return it directly and skip embedding. On the 15-question subset this kept every exact-keyword answer and still let fusion improve the rest; median latency for gated queries was ~1.5 ms.

## What did not work

| idea | result |
| --- | --- |
| center vectors by subtracting the mean | top1 8→4/15 — short queries sit near the mean |
| kind/source priors (×1.5–2) | lexical 17→18, fused 19→16 — double weighting |
| adding lexical and cosine scores | 10/15 — scales differ, no calibration works |
| chunk long documents, max-sim | target 0.528 vs 0.517 — noise |
| drop messages shorter than N chars | no stable gain |
| dedupe candidates by cosine ≥0.93/0.96 | 13/15 unchanged |
| dedupe by title Jaccard | unchanged; the wrong answers were not duplicates |
| filter "assistant" messages | 16/22 — they carry facts, not only noise |

The failure mode was consistent: the wrong answers were a dozen *independent* short messages that both lists ranked mid-pack. RRF rewards that consensus; dedupe and priors cannot see it. Fixing it requires indexing by conversation turn or giving short messages context — a different pipeline, not a knob.

## Recall depth

For 30 questions, the lexical top-20 contained the answer 27 times; fused top-20 28 times; top-50 did not improve. Eleven failures were ranking failures, two were true recall failures — the query word simply never appears in the target text (e.g. asking about "childhood injuries" when the store says "broke my arm"). Query expansion rules (受伤 → 摔断/烫伤/留疤) recovered three of them, at the cost of being hand-written for the test set.

## Cost

| configuration | RSS |
| --- | --- |
| bare Node + DB | 57 MB |
| + bigram FTS | 101 MB |
| + model & 5.1k vectors | 169 MB |

If you do not need semantic recall, `MEM_HYBRID=0` saves ~75 MB and one dependency.
