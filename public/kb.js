// Ask widget for the AI knowledge graph. Add <script src="https://quick-chat-program.pages.dev/kb.js" defer></script> to any allowed site.
// Needle 2 turns the question into a vector in a Web Worker in the browser; the read-only API ranks graph entries with it plus keywords and answers.
(function () {
  if (window.aiKnowledge) return;
  var me = document.currentScript;
  var BASE = new URL(me.src).origin;
  var INLINE = me.dataset.inline ? document.querySelector(me.dataset.inline) : null;
  var CACT_SHA = "b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba";
  var KIND = { step: "Learning path step", resource: "Learning resource", section: "Lesson section", outline: "Coming soon", concept: "Concept", tool: "Language or tool", lesson: "Lesson", module: "Module", area: "Area", domain: "Industry", course: "Course", qa: "Answer", root: "Overview" };
  var REL = [["uses", "Resources"], ["recommended_in", "Recommended in"], ["questions", "Questions about this"], ["related", "Related"], ["teaches", "Covers"], ["taught_in", "Learn it in"], ["includes", "Includes"],
    ["has_lesson", "Lessons"], ["about", "About"], ["part_of", "Part of"], ["in_module", "In module"], ["has_course", "Courses"], ["covers", "Covers"]];

  var css = document.createElement("link");
  css.rel = "stylesheet"; css.href = BASE + "/kb.css";
  document.head.append(css);

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path) { return fetch(BASE + "/api" + path).then(function (r) { if (!r.ok) throw new Error("API " + r.status); return r.json(); }); }

  // ---------- panel ----------
  var panel = el(INLINE ? "section" : "aside", "kb-panel" + (INLINE ? " kb-inline" : ""));
  panel.setAttribute("aria-label", "Ask about AI, building and industries");
  var head = el("div", "kb-head");
  var titles = el("div", "kb-titles");
  titles.append(el("p", "kb-title", "Ask"), el("p", "kb-sub", "AI, code, cloud, the FDE role and MedTech and Pharma quality"));
  head.append(titles);
  var log = el("div", "kb-log");
  log.setAttribute("aria-live", "polite");
  var form = el("form", "kb-form"), input = el("input"), send = el("button", "kb-send", "Ask");
  input.type = "search"; input.placeholder = "For example: why is Python used for AI?"; input.setAttribute("aria-label", "Your question");
  form.append(input, send);
  var foot = el("p", "kb-foot", "Answers come from the course content. Your question's meaning is worked out on your device.");
  panel.append(head, log, form, foot);
  var btn = null;
  if (INLINE) INLINE.append(panel);
  else {
    btn = el("button", "kb-btn");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg><span>Ask</span>';
    btn.setAttribute("aria-expanded", "false");
    var close = el("button", "kb-close");
    close.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';
    close.setAttribute("aria-label", "Close");
    head.append(close);
    panel.hidden = true;
    document.body.append(btn, panel);
    btn.onclick = function () { toggle(panel.hidden); };
    close.onclick = function () { toggle(false); };
  }
  function toggle(open) {
    panel.hidden = !open;
    if (btn) btn.setAttribute("aria-expanded", String(open));
    if (open) { input.focus(); warm(); }
  }

  // ---------- meaning search (Needle 2 in a module Web Worker) ----------
  var worker = null, ready = null, nid = 1, pend = {};
  function warm() {
    if (ready) return ready;
    var src = 'import init, { NeedleV2Wasm } from "' + BASE + '/needle/needle_wasm.js";\n' +
      "let engine;\n" +
      "async function cact() {\n" +
      '  const url = "' + BASE + '/needle/needle2.cact";\n' +
      '  const cache = await caches.open("ai-knowledge-needle2");\n' +
      "  let res = await cache.match(url);\n" +
      "  if (!res) { res = await fetch(url); if (!res.ok) throw new Error('model ' + res.status); await cache.put(url, res.clone()); }\n" +
      "  const buf = await res.arrayBuffer();\n" +
      "  const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');\n" +
      '  if (sum !== "' + CACT_SHA + '") { await cache.delete(url); throw new Error("model checksum mismatch"); }\n' +
      "  return new Uint8Array(buf);\n" +
      "}\n" +
      "self.onmessage = async (e) => {\n" +
      "  try {\n" +
      "    if (!engine) { await init({ module_or_path: '" + BASE + "/needle/needle_wasm_bg.wasm' }); engine = NeedleV2Wasm.load(await cact()); }\n" +
      "    if (e.data.warm) return self.postMessage({ ready: true });\n" +
      "    self.postMessage({ id: e.data.id, vec: engine.encode_contrastive(e.data.text) });\n" +
      "  } catch (err) { self.postMessage({ id: e.data.id, error: String(err && err.message || err) }); }\n" +
      "};\n";
    ready = new Promise(function (resolve, reject) {
      try { worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" }); } catch (e) { return reject(e); }
      worker.onmessage = function (m) {
        var d = m.data;
        if (d.ready) return resolve(worker);
        if (d.error && !d.id) return reject(new Error(d.error));
        var p = pend[d.id]; if (!p) return; delete pend[d.id];
        if (d.error) p.reject(new Error(d.error)); else p.resolve(d.vec);
      };
      worker.onerror = function (e) { reject(new Error(e.message || "worker failed")); };
      worker.postMessage({ warm: true });
    });
    ready.catch(function () { ready = null; });
    return ready;
  }
  function embed(text) {
    return warm().then(function (w) { return new Promise(function (resolve, reject) { var id = nid++; pend[id] = { resolve: resolve, reject: reject }; w.postMessage({ id: id, text: text }); }); });
  }
  // The question's meaning as 128 int8 numbers in base64, sent with the question; the server does the ranking.
  function vecParam(v) {
    var s = "";
    for (var i = 0; i < v.length; i++) s += String.fromCharCode(Math.max(-127, Math.min(127, Math.round(v[i] * 127))) & 255);
    return btoa(s);
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }

  // ---------- answering ----------
  // New answers scroll so their first line shows; long answers are read from the top.
  function say(cls, node) {
    var m = el("div", "kb-msg " + cls); m.append(node); log.append(m);
    log.scrollTop = cls === "kb-bot" ? Math.max(0, m.offsetTop - log.offsetTop - 12) : log.scrollHeight;
    return m;
  }
  function ask(q) {
    q = String(q || "").trim();
    if (!q) return;
    if (btn && panel.hidden) toggle(true);
    say("kb-me", el("p", "", q));
    var wait = say("kb-bot", el("p", "kb-muted", "Looking it up..."));
    var slow = setTimeout(function () { wait.firstChild.textContent = "Loading meaning search, about 14 MB the first time only..."; }, 1500);
    withTimeout(embed(q).catch(function () { return null; }), 8000).then(function (v) {
      clearTimeout(slow);
      return api("/ask?q=" + encodeURIComponent(q) + (v ? "&v=" + encodeURIComponent(vecParam(v)) : ""));
    }).then(function (r) {
      wait.remove();
      if (r.mode === "match" || r.mode === "closest") return render(r.node, r.mode === "closest" ? "Closest entry I have:" : "", r.also);
      if (r.mode === "composed") return composed(r);
      none(r.also);
    }).catch(function (e) { wait.firstChild.textContent = "Could not reach the knowledge service: " + e.message; });
  }
  function composed(r) {
    var box = el("div", "kb-answer");
    box.append(el("p", "kb-kind", "Answer from the course content"), el("p", "kb-text", r.answer));
    var list = el("ol", "kb-sources");
    r.sources.forEach(function (x) { var li = el("li"), b = el("button", "kb-link", x.title); b.type = "button"; b.onclick = function () { show(x.id); }; li.append(b); list.append(li); });
    box.append(el("p", "kb-rel", "Sources"), list, el("p", "kb-muted", "Written by a small AI model from these sources. Check them before you rely on it."));
    say("kb-bot", box);
  }
  function none(ids) {
    var box = el("div");
    box.append(el("p", "", "I do not have an answer for that in the course content. I cover AI, programming, cloud and security, the FDE role, this program, and MedTech and Pharma quality topics." + ((ids || []).length ? " Closest topics:" : "")));
    if ((ids || []).length) chipsFor(box, ids);
    say("kb-bot", box);
  }
  function chipsFor(box, ids) {
    var row = el("div", "kb-chips");
    ids.forEach(function (id) {
      api("/node/" + encodeURIComponent(id)).then(function (n) { var c = el("button", "kb-chip", n.title); c.type = "button"; c.onclick = function () { show(n.id); }; row.append(c); });
    });
    box.append(row);
  }
  function show(id) {
    var wait = say("kb-bot", el("p", "kb-muted", "Opening..."));
    api("/node/" + encodeURIComponent(id)).then(function (n) { wait.remove(); render(n, "", []); })
      .catch(function (e) { wait.firstChild.textContent = "Could not reach the knowledge service: " + e.message; });
  }
  function render(n, note, also) {
    var box = el("div", "kb-answer");
    if (note) box.append(el("p", "kb-muted", note));
    box.append(el("p", "kb-kind", KIND[n.kind] || n.kind), el("h4", "", n.title));
    if (n.summary) box.append(el("p", "kb-text", n.summary));
    if (n.why) { var w = el("p", ""); w.append(el("b", "", "Why it matters: "), n.why); box.append(w); }
    if (n.body) box.append(el("p", "kb-muted", n.body));
    if (n.link) { var a = el("a", "kb-read", "Read more"); a.href = n.link; a.target = "_blank"; a.rel = "noopener"; box.append(a); }
    REL.forEach(function (pair) {
      var list = (n.links[pair[0]] || []).filter(function (x) { return x.kind !== "root" && x.kind !== "section"; }).slice(0, 8);
      if (!list.length) return;
      box.append(el("p", "kb-rel", pair[1]));
      var row = el("div", "kb-chips");
      list.forEach(function (x) { var c = el("button", "kb-chip", x.title); c.type = "button"; c.title = KIND[x.kind] || x.kind; c.onclick = function () { show(x.id); }; row.append(c); });
      box.append(row);
    });
    if ((also || []).length) { box.append(el("p", "kb-rel", "Also related")); chipsFor(box, also); }
    say("kb-bot", box);
  }
  form.onsubmit = function (e) { e.preventDefault(); var q = input.value; input.value = ""; ask(q); };
  window.aiKnowledge = { ask: ask, show: show, open: function () { toggle(true); }, warm: warm };
  if (INLINE) warm();
})();
