// 可选：向量召回 + RRF 融合。
// 依赖 @huggingface/transformers（Node 端跑 ONNX）；模型目录里放一份 bge-small-zh-v1.5 的 ONNX 导出。
// 任何一步失败都抛错，由 server 降级回纯词法。
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function createHybrid(db, opts = {}) {
  const modelDir = opts.modelDir || process.env.MEM_MODEL_DIR;
  if (!modelDir) throw new Error("MEM_MODEL_DIR 未设置");
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const tf = await import(pathToFileURL(req.resolve("@huggingface/transformers")).href);
  tf.env.allowRemoteModels = false;
  const t0 = Date.now();
  const pipe = await tf.pipeline("feature-extraction", modelDir, {
    dtype: "q8",
    local_files_only: true,
  });
  const loadMs = Date.now() - t0;

  const vecStmt = db.prepare(
    "select v.id, v.vec from mem_vectors v join memories m on m.id = v.id where m.superseded_by is null"
  );
  const loadVecs = () =>
    vecStmt.all().map((r) => ({
      id: r.id,
      v: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.length / 4),
    }));
  let vecs = loadVecs();
  const dim = vecs[0]?.v.length || 0;
  if (!dim) throw new Error("mem_vectors 为空，先跑一次向量化");

  const qCache = new Map(); // 查询文本 → 向量，上限 500
  async function embed(text) {
    const hit = qCache.get(text);
    if (hit) return hit;
    const out = await pipe([text], { pooling: "mean", normalize: true });
    const v = out.tolist()[0];
    qCache.set(text, v);
    if (qCache.size > 500) qCache.delete(qCache.keys().next().value);
    return v;
  }

  function cosine(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i += 1) d += a[i] * b[i];
    return d;
  }

  let lastEmbedMs = 0;
  async function rank(q, k = 50) {
    const t = Date.now();
    const qv = await embed(q);
    lastEmbedMs = Date.now() - t;
    const out = [];
    for (const { id, v } of vecs) out.push({ id, s: cosine(qv, v) });
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, k);
  }

  // Reciprocal Rank Fusion：两路排名各给 1/(60+rank)，importance 只做极轻微加权
  function fuse(lexIds, semIds, importanceOf = () => 0) {
    const rankL = new Map(lexIds.map((id, i) => [id, i]));
    const rankS = new Map(semIds.map((id, i) => [id, i]));
    const ids = new Set([...lexIds, ...semIds]);
    const out = [];
    for (const id of ids) {
      const rl = rankL.has(id) ? 1 / (60 + rankL.get(id)) : 0;
      const rs = rankS.has(id) ? 1 / (60 + rankS.get(id)) : 0;
      out.push({ id, s: rl + rs + 0.002 * Number(importanceOf(id) || 0) });
    }
    out.sort((a, b) => b.s - a.s);
    return out;
  }

  function refresh() {
    const next = loadVecs();
    if (next.length !== vecs.length) {
      vecs = next;
      return true;
    }
    return false;
  }

  return { ok: true, model: path.basename(modelDir), dim, rows: vecs.length, loadMs, rank, fuse, refresh };
}
