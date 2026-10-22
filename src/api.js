// Read-only knowledge graph API. Only fixed SELECT statements with bound values; no route writes anything.
// /api/ask ranks entries by keyword search, exact names and the browser's Needle 2 vector, then answers from the graph or, when unsure, has Workers AI summarise the closest entries.
// Browsers on the allowed sites call it; the D1 binding never leaves this function.
// Sites allowed to call the API: ALLOWED_ORIGINS (comma separated, set in .env and rendered into wrangler.toml). Preview subdomains of a
// listed pages.dev site and local development are allowed too.
const DEFAULT_ORIGINS = "https://fde-training-program.pages.dev,https://quick-chat-program.pages.dev";
let ORIGINS = [];
function setOrigins(env) {
  ORIGINS = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
}
function allowed(origin) {
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return ORIGINS.some((o) => o === origin || (o.endsWith(".pages.dev") && origin.endsWith("." + o.replace(/^https:\/\//, "")) && origin.startsWith("https://")));
}
const MAX_Q = 300;
// Filler words never decide a match.
const STOP = new Set(("a an the is are was were be been am do does did doing done what whats which who whom whose why how when where can could should would will " +
  "shall may might must i me my we our you your it its this that these those there here of in on at to for from by with about as into than then so " +
  "and or but if not no yes vs versus diff difference between mean means meaning explain tell please hi hey ok okay just really actually also get got " +
  "need want know use used using like").split(" "));

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  return allowed(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
}

const json = (request, data, status = 200, cache = 300) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? `public, max-age=${cache}` : "no-store", ...cors(request) } });

const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };
const pub = (n) => n && { id: n.id, kind: n.kind, title: n.title, summary: n.summary, body: n.body, why: n.why, link: n.link, aliases: parse(n.aliases) };

// Full-text search over titles, aliases and summaries. Words only, so user text never becomes FTS syntax.
async function search(env, q, limit) {
  const words = (q.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 12);
  if (!words.length) return [];
  const match = words.map((w) => `"${w}"*`).join(" OR ");
  const rows = (await env.KB.prepare(`SELECT n.id, n.kind, n.title, n.summary, bm25(search, 0.0, 4.0, 1.0) AS score
      FROM search JOIN nodes n ON n.id = search.id WHERE search MATCH ? ORDER BY score LIMIT ?`).bind(match, limit).all()).results;
  return rows.map((r) => ({ ...r, score: Math.round(-r.score * 100) / 100 }));
}

// One node with its neighbours in both directions, grouped by relation, so the widget can show related topics and where to learn.
async function nodeWithLinks(env, id) {
  const [n, out, inc] = await env.KB.batch([
    env.KB.prepare("SELECT * FROM nodes WHERE id = ?").bind(id),
    env.KB.prepare("SELECT e.rel, n.id, n.kind, n.title, n.link FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? LIMIT 60").bind(id),
    env.KB.prepare("SELECT e.rel, n.id, n.kind, n.title, n.link FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? LIMIT 60").bind(id),
  ]);
  const node = n.results[0];
  if (!node) return null;
  const links = {};
  const add = (rel, r) => (links[rel] = links[rel] || []).push({ id: r.id, kind: r.kind, title: r.title, link: r.link });
  for (const r of out.results) add(r.rel, r);
  for (const r of inc.results) add({ uses: "recommended_in", includes: "part_of", has_lesson: "in_module", taught_in: "teaches", about: "questions", related: "related", covers: "part_of", has_course: "part_of" }[r.rel] || r.rel, r);
  return { ...pub(node), links };
}

// ---------- ask ----------
const KIND_BONUS = { step: 0.01, resource: 0, qa: 0.03, concept: 0.02, tool: 0.02, domain: 0.02, section: 0, lesson: 0.005, outline: -0.01, course: 0, module: -0.01, area: -0.01 };
const SURE = 0.86, ALONE = 0.9, GAP = 0.03, NEAR = 0.84, FLOOR = 0.7;
const LEAD = /^(please |hey |hi |so |ok |okay )*(can you |could you |pls )?(tell me |explain |define |describe )?(what is |what's |whats |what are |what does |meaning of |the meaning of |about )?(an |a |the )?/;
const TAIL = /\s+(means?|meaning|stands? for|definition|is|in simple words|in plain words)$/;
let VEC = null;

async function vectors(request, env) {
  if (VEC) return VEC;
  const d = await (await env.ASSETS.fetch(new URL("/vectors.json", request.url))).json();
  const bin = atob(d.q), q = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24;
  VEC = { dims: d.dims, ids: d.ids, q };
  return VEC;
}

function decodeVec(v, dims) {
  try {
    const bin = atob(v);
    if (bin.length !== dims) return null;
    return Int8Array.from(bin, (c) => (c.charCodeAt(0) << 24) >> 24);
  } catch { return null; }
}

// Closest phrase per node, by dot product of the two int8 vectors (both were L2-normalised before quantising).
function nearest(V, qv, k) {
  const best = new Map();
  for (let i = 0; i < V.ids.length; i++) {
    let s = 0;
    const o = i * V.dims;
    for (let j = 0; j < V.dims; j++) s += qv[j] * V.q[o + j];
    s /= 127 * 127;
    if (!(best.get(V.ids[i]) >= s)) best.set(V.ids[i], s);
  }
  const top = [...best].map(([id, s]) => ({ id, s })).sort((a, b) => b.s - a.s).slice(0, k);
  top.all = best;
  return top;
}

async function exact(env, name) {
  if (!name || name.length < 2) return null;
  const r = await env.KB.prepare(`SELECT n.id, n.kind FROM nodes n, json_each(n.aliases) a WHERE a.value = ?
      ORDER BY CASE n.kind WHEN 'concept' THEN 0 WHEN 'tool' THEN 0 WHEN 'domain' THEN 1 WHEN 'qa' THEN 2 ELSE 3 END LIMIT 1`).bind(name).first();
  return r || null;
}

async function ask(request, env, url) {
  const q = (url.searchParams.get("q") || "").slice(0, MAX_Q).trim();
  if (!q) return { mode: "none" };
  const name = q.toLowerCase().replace(/[?!.]+$/g, "").replace(LEAD, "").replace(TAIL, "").trim();
  const V = await vectors(request, env);
  const qv = decodeVec(url.searchParams.get("v") || "", V.dims);
  const [hit, fts] = await Promise.all([exact(env, name), search(env, q, 10)]);
  const near = qv ? nearest(V, qv, 12) : [];
  const kinds = Object.fromEntries(fts.map((r) => [r.id, r.kind]));
  const missing = near.map((n) => n.id).filter((id) => !kinds[id]);
  if (missing.length) {
    const rows = (await env.KB.prepare(`SELECT id, kind FROM nodes WHERE id IN (${missing.map(() => "?").join(",")})`).bind(...missing).all()).results;
    for (const r of rows) kinds[r.id] = r.kind;
  }
  const top = fts.length ? fts[0].score : 1;
  const score = new Map();
  for (const n of near) score.set(n.id, { id: n.id, cos: n.s, fts: 0 });
  // Keyword hits get their real meaning score too, so a strong keyword match can win even outside the top meaning matches.
  for (const r of fts) { const c = score.get(r.id) || { id: r.id, cos: near.all ? near.all.get(r.id) || 0 : 0, fts: 0 }; c.fts = r.score / top; score.set(r.id, c); }
  const ranked = [...score.values()].map((c) => ({ ...c, kind: kinds[c.id], total: c.cos + 0.08 * c.fts + (KIND_BONUS[kinds[c.id]] || 0) }))
    .sort((a, b) => b.total - a.total);
  const best = ranked[0], second = ranked[1];
  const sure = hit ? { id: hit.id, why: "name" }
    : best && qv && best.cos >= (best.fts > 0 ? SURE : ALONE) && (!second || best.cos - second.cos >= GAP) ? { id: best.id, why: "meaning" }
    : best && qv && best.cos >= NEAR && fts.length && fts[0].id === best.id ? { id: best.id, why: "meaning and words" }
    : best && !qv && fts.length && (fts.length === 1 || fts[0].score >= 1.5 * fts[1].score) ? { id: fts[0].id, why: "words" } : null;
  const alsoIds = ranked.filter((r) => !sure || r.id !== sure.id).slice(0, 3).map((r) => r.id);
  const top3 = ranked.slice(0, 3).map((r) => ({ id: r.id, cos: Math.round(r.cos * 1000) / 1000, fts: Math.round(r.fts * 100) / 100 }));
  if (sure) return { mode: "match", by: sure.why, node: await nodeWithLinks(env, sure.id), also: alsoIds, top: top3 };
  const weak = !ranked.length || (qv ? ranked[0].cos < FLOOR && !fts.length : !fts.length);
  if (weak) return { mode: "none", also: alsoIds, top: top3 };
  return { ...(await compose(env, q, ranked.slice(0, 5).map((r) => r.id), alsoIds)), top: top3 };
}

// Not one clear entry: let a small model answer only from the closest entries, or say it cannot.
async function compose(env, q, ids, alsoIds) {
  const rows = (await env.KB.prepare(`SELECT id, kind, title, summary, why, body, link FROM nodes WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
  const order = Object.fromEntries(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => order[a.id] - order[b.id]);
  const sources = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, link: r.link }));
  if (!env.AI) return { mode: "closest", node: await nodeWithLinks(env, ids[0]), also: alsoIds };
  const notes = rows.map((r, i) => `[${i + 1}] ${r.title}\n${[r.summary, r.why, r.body].filter(Boolean).join(" ")}`).join("\n\n").slice(0, 6000);
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You answer questions for a training program about AI, software, cloud, security, the forward deployed engineer role, and MedTech and Pharma quality and regulation. Use only the numbered notes. Answer in plain, simple English in at most 5 sentences, and cite notes like [1]. If the notes do not answer the question, or it is outside these topics, reply exactly NO_ANSWER." },
        { role: "user", content: `Notes:\n${notes}\n\nQuestion: ${q}` },
      ],
      max_tokens: 260, temperature: 0.2,
    });
    const text = String((out && out.response) || "").trim();
    if (!text || /NO_ANSWER/.test(text)) return { mode: "none", also: alsoIds };
    return { mode: "composed", answer: text, sources };
  } catch (e) {
    console.error("ai", e);
    return { mode: "closest", node: await nodeWithLinks(env, ids[0]), also: alsoIds };
  }
}

export async function handle(request, env) {
  setOrigins(env);
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(request), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET") return json(request, { error: "Read-only API" }, 405);
  try {
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { return json(request, { error: "Bad path" }, 400); }
    if (path === "/api/health") return json(request, { ok: true }, 200, 0);
    if (path === "/api/search") {
      const q = (url.searchParams.get("q") || "").slice(0, MAX_Q);
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 6));
      return json(request, { q, results: await search(env, q, limit) });
    }
    if (path === "/api/ask") return json(request, await ask(request, env, url), 200, 0);
    let m = path.match(/^\/api\/node\/([a-z]:[a-z0-9:_-]{1,160}|root)$/);
    if (m) {
      const n = await nodeWithLinks(env, m[1]);
      return n ? json(request, n) : json(request, { error: "Not found" }, 404);
    }
    if (path === "/api/overview") {
      const [nodes, edges] = await env.KB.batch([
        env.KB.prepare("SELECT id, kind, title FROM nodes WHERE kind <> 'qa'"),
        env.KB.prepare("SELECT src, rel, dst FROM edges WHERE rel IN ('covers', 'includes', 'has_lesson', 'has_course')"),
      ]);
      return json(request, { nodes: nodes.results, edges: edges.results }, 200, 3600);
    }
    return json(request, { error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json(request, { error: "Server error" }, 500);
  }
}
