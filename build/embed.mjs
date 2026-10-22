// Embeds every searchable phrase with Needle 2 (the same model the browser runs) into public/vectors.json: int8, 128 numbers each.
// Phrases: each question and its other wordings, "what is X" for concepts and tools, lesson sections with their first sentence, and other titles.
// Runs one Needle engine per CPU core in worker threads, since one encode takes about 0.2 s.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { initSync, NeedleV2Wasm } from "../public/needle/needle_wasm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!isMainThread) {
  initSync({ module: readFileSync(join(ROOT, "public/needle/needle_wasm_bg.wasm")) });
  const engine = NeedleV2Wasm.load(new Uint8Array(readFileSync(join(ROOT, "public/needle/needle2.cact"))));
  parentPort.postMessage(workerData.map((text) => Array.from(engine.encode_contrastive(text) || [])));
} else {
  const graph = JSON.parse(readFileSync(join(ROOT, "out/graph.json"), "utf8"));
  const phrases = [];
  const alts = Object.fromEntries(graph.qa.map((q) => [q.id, q.alts]));
  for (const n of graph.nodes) {
    if (n.kind === "qa") for (const p of [n.title, ...(alts[n.id] || [])]) phrases.push([n.id, p]);
    else if (n.kind === "concept" || n.kind === "tool") { phrases.push([n.id, `What is ${n.title}?`]); phrases.push([n.id, n.title]); }
    else if (n.kind === "section") phrases.push([n.id, n.title + ". " + n.summary.split(". ")[0].slice(0, 160)]);
    else if (n.kind !== "root") phrases.push([n.id, n.title]);
  }
  const t0 = Date.now(), cores = Math.max(1, availableParallelism() - 1), size = Math.ceil(phrases.length / cores);
  const parts = await Promise.all(Array.from({ length: cores }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: phrases.slice(i * size, (i + 1) * size).map((p) => p[1]) });
    w.once("message", resolve); w.once("error", reject);
  })));
  const vecs = parts.flat(), ids = [], rows = [];
  vecs.forEach((v, i) => { if (v.length) { ids.push(phrases[i][0]); rows.push(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))))); } });
  const dims = rows[0].length, flat = new Int8Array(rows.length * dims);
  rows.forEach((r, i) => flat.set(r, i * dims));
  writeFileSync(join(ROOT, "public/vectors.json"), JSON.stringify({ model: "needle2", dims, ids, q: Buffer.from(flat.buffer).toString("base64") }));
  console.log(`embedded ${ids.length} phrases (${dims} dims) on ${cores} threads in ${Math.round((Date.now() - t0) / 1000)} s`);
}
