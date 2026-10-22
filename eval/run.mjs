// Scores the chat on eval/questions.json against the local API: embeds each question with Needle 2 (as the browser does) and calls /api/ask.
// A question counts as answered well when the answer text holds one of its expected words; out-of-scope questions should get no answer.
// Usage: node eval/run.mjs [base_url] [--no-ai]   Writes eval/report.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, NeedleV2Wasm } from "../public/needle/needle_wasm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:8792";
initSync({ module: readFileSync(join(ROOT, "public/needle/needle_wasm_bg.wasm")) });
const engine = NeedleV2Wasm.load(new Uint8Array(readFileSync(join(ROOT, "public/needle/needle2.cact"))));
const vec = (v) => Buffer.from(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer).toString("base64");
// Extra question files (for example a private organisation's own topics) are listed in KB_EXTRA_EVAL, separated by ":".
const questions = [join(ROOT, "eval/questions.json"), ...(process.env.KB_EXTRA_EVAL || "").split(":").filter(Boolean).map((f) => resolve(ROOT, f))]
  .flatMap((f) => JSON.parse(readFileSync(f, "utf8")).questions);

const text = (r) => {
  if (r.mode === "match" || r.mode === "closest") { const n = r.node; return [n.title, n.summary, n.why, n.body].join(" "); }
  if (r.mode === "composed") return r.answer + " " + r.sources.map((s) => s.title).join(" ");
  return "";
};
// Loose word match so "hallucinate" counts for "hallucination": each expected word is cut to its stem.
const stems = (w) => w.toLowerCase().split(/[\s-]+/).filter(Boolean).map((x) => (x.length > 6 ? x.slice(0, x.length - 3) : x));
const rows = [], by = {};
for (const q of questions) {
  const r = await (await fetch(`${BASE}/api/ask?q=${encodeURIComponent(q.q)}&v=${encodeURIComponent(vec(engine.encode_contrastive(q.q)))}`, { headers: { Origin: "http://127.0.0.1" } })).json();
  const t = text(r).toLowerCase();
  const ok = q.kind === "out" ? r.mode === "none" : q.expect.some((w) => stems(w).every((x) => t.includes(x)));
  const a = (by[q.area] = by[q.area] || { n: 0, ok: 0, none: 0, modes: {} });
  a.n++; a.ok += ok ? 1 : 0; a.none += r.mode === "none" ? 1 : 0; a.modes[r.mode] = (a.modes[r.mode] || 0) + 1;
  rows.push({ id: q.id, area: q.area, q: q.q, expect: q.expect, ok, mode: r.mode, by: r.by, got: r.node ? r.node.title : r.mode === "composed" ? r.answer.slice(0, 140) : "", top: r.top });
}
const inQ = rows.filter((r) => r.area !== "out-of-scope"), outQ = rows.filter((r) => r.area === "out-of-scope");
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + "%";
for (const [k, a] of Object.entries(by).sort()) console.log(k.padEnd(18), `${pct(a.ok, a.n).padStart(4)} good of ${String(a.n).padStart(3)}`, JSON.stringify(a.modes));
console.log("in-scope good:", pct(inQ.filter((r) => r.ok).length, inQ.length), "| out-of-scope declined:", pct(outQ.filter((r) => r.ok).length, outQ.length));
writeFileSync(join(ROOT, "eval/report.json"), JSON.stringify({ at: new Date().toISOString(), by, rows }, null, 1));
