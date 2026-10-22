#!/usr/bin/env python3
"""Builds the AI knowledge graph from the fde-training content: concepts, areas, modules, lessons, domains, languages and tools, courses, Q&A.
Writes out/graph.json (for embedding and checks) and out/seed.sql (for D1). Usage: build/build_graph.py [fde_training_dir]"""

import json, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def here(d):
    """Paths from .env are relative to this project folder."""
    p = Path(d)
    return p if p.is_absolute() else (ROOT / p).resolve()


FDE = here(sys.argv[1]) if len(sys.argv) > 1 else here(os.environ.get("FDE_DIR", "../fde-training"))
C = FDE / "content"
OUT = ROOT / "out"
SITE = os.environ.get("KB_SITE_URL", "https://fde-training-program.pages.dev/")
# Optional LMS that hosts the topic courses (course links point there); without it those links are left out.
LMS = (os.environ.get("KB_LMS_URL", "").rstrip("/") + "/course/") if os.environ.get("KB_LMS_URL") else None
# Optional extra folders, separated by ":", for private topic courses and private Q&A files.
def lms(path):
    return LMS + path if LMS else None


EXTRA_TOPICS = [here(d) for d in os.environ.get("KB_EXTRA_TOPICS", "").split(":") if d]
EXTRA_CONTENT = [here(d) for d in os.environ.get("KB_EXTRA_CONTENT", "").split(":") if d]

nodes, edges, qa = {}, set(), []


def load(p, default=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def aliases_of(term):
    """'Large language model (LLM)' gives 'large language model' and 'llm'; 'Git and repository' gives both halves."""
    out = {term.lower()}
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", term)
    if m:
        out |= {m.group(1).lower().strip(), m.group(2).lower().strip()}
    for part in re.split(r"\s+and\s+|,\s*", re.sub(r"\(.*?\)", "", term)):
        if len(part.strip()) > 2:
            out.add(part.strip().lower())
    return sorted(a for a in out if a)


# Aliases that are also everyday words only match in their exact case and spelling (Go the language, not "go to").
AMBIGUOUS = {"go"}


class Pattern:
    def __init__(self, loose, exact):
        self.loose = re.compile(r"\b(" + "|".join(map(re.escape, loose)) + r")\b", re.I) if loose else None
        self.exact = re.compile(r"\b(" + "|".join(map(re.escape, exact)) + r")\b") if exact else None

    def findall(self, text):
        return (self.loose.findall(text) if self.loose else []) + (self.exact.findall(text) if self.exact else [])

    def search(self, text):
        return bool(self.findall(text))


def pattern(n):
    loose = [a for a in n["aliases"] if len(a) > 2 and a not in AMBIGUOUS]
    exact = [n["title"]] if n["title"].lower() in AMBIGUOUS else []
    return Pattern(loose, exact)


def node(nid, kind, title, summary="", body="", why="", link=None, aliases=None, source=""):
    nodes[nid] = {"id": nid, "kind": kind, "title": title, "summary": summary, "body": body, "why": why, "link": link,
                  "aliases": aliases or [title.lower()], "source": source}


def edge(a, rel, b):
    if a in nodes and b in nodes and a != b:
        edges.add((a, rel, b))


def clip(text, n):
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "..."


def lesson_text(l):
    parts = [l.get("summary", ""), l.get("why", "")] + [p for s in l.get("sections", []) for p in s.get("p", []) + s.get("list", [])]
    return " ".join(parts)


def build():
    node("root", "root", "AI for real work", "Everything an engineer or domain expert needs to use today's AI well: how the pieces work, how to build with them, and how to read an industry.")
    b = load(C / "basics.json")
    for g in b["groups"]:
        gid = "a:" + g["id"]
        node(gid, "area", g["title"], g.get("intro", ""), link=f"{SITE}learn/basics.html#g-{g['id']}", source="basics")
        edge("root", "covers", gid)
        for t in g["terms"]:
            cid = "c:" + slug(t["term"])
            node(cid, "concept", t["term"], t["one"], why=t.get("why", ""), body=" ".join(x for x in (t.get("like"), t.get("vs")) if x),
                 link=f"{SITE}learn/basics.html#t-{slug(t['term'])}", aliases=aliases_of(t["term"]), source="basics")
            edge(gid, "includes", cid)

    for d, label in (("medtech", "MedTech"), ("pharma", "Pharma")):
        v = load(C / "variants" / d / "variant.json", {})
        did = "d:" + d
        node(did, "domain", label, v.get("summary", ""), link=lms(f"fde-general-{d}"), aliases=[d, label.lower(), "medical devices" if d == "medtech" else "pharmaceutical"], source="variant")
        edge("root", "covers", did)
        g = (load(C / "variants" / d / "basics.json", {"groups": []})["groups"] or [None])[0]
        for t in (g or {}).get("terms", []):
            cid = "c:" + slug(t["term"])
            if cid not in nodes:
                node(cid, "concept", t["term"], t["one"], why=t.get("why", ""), link=lms(f"fde-general-{d}/basics"), aliases=aliases_of(t["term"]), source=d)
            edge(did, "includes", cid)

    lang = load(C / "languages.json")
    pl = load(C / "languages-playlist.json", {"groups": []})
    if lang:
        node("a:languages", "area", "Languages, AI SDKs and DevOps", lang["intro"], link=f"{SITE}learn/languages.html", source="languages")
        edge("root", "covers", "a:languages")
    for g in pl["groups"]:
        for it in g["items"]:
            tid = "t:" + it["id"]
            start = next((l for lv in it["levels"] if lv["level"] == "Start" for l in lv["links"]), None)
            node(tid, "tool", it["name"], it["why"], link=f"{SITE}learn/languages.html#pl-{it['id']}",
                 aliases=sorted({it["name"].lower(), it["id"]} | set(aliases_of(it["name"])) | ({"golang"} if it["id"] == "go" else set())), source="languages",
                 body=f"Start with: {start['title']} ({start['source']})." if start else "")
            edge("a:languages", "includes", tid)

    for f in sorted(C.glob("m[0-9][0-9].json")):
        m = load(f)
        mid = f"m:{f.stem}"
        node(mid, "module", f'Module {m["module"]:02d}: {m["title"]}', m["intro"], link=f"{SITE}learn/{f.stem}.html", source="modules")
        edge("root", "covers", mid)
        for l in m["lessons"]:
            lid = "l:" + l["id"]
            node(lid, "lesson", l["title"], l["summary"], why=l.get("why", ""), link=f"{SITE}learn/{f.stem}.html#l-{l['id']}", source=f.stem)
            nodes[lid]["text"] = lesson_text(l)
            nodes[lid]["sections"] = l.get("sections", []) + ([{"h": "Worked example", **l["example"]}] if l.get("example") else [])
            edge(mid, "has_lesson", lid)
    for d in ("medtech", "pharma"):
        for f in sorted((C / "variants" / d).glob("m[0-9][0-9].json")):
            v = load(f)
            mid = f"m:{f.stem}"
            for l in v.get("lessons", []) + v.get("add_first", []) + v.get("add", []):
                lid = "l:" + l["id"]
                node(lid, "lesson", l["title"], l["summary"], why=l.get("why", ""), link=lms(f"fde-general-{d}/{f.stem}"), source=d)
                nodes[lid]["text"] = lesson_text(l)
                nodes[lid]["sections"] = l.get("sections", []) + ([{"h": "Worked example", **l["example"]}] if l.get("example") else [])
                edge(mid, "has_lesson", lid)
                edge("d:" + d, "taught_in", lid)

    for f in sorted((C / "topics").glob("*.json")) + sorted(f for d in EXTRA_TOPICS for f in d.glob("*.json")):
        t = load(f)
        kid = "k:" + t["id"]
        node(kid, "course", t["title"], t.get("summary", ""), link=lms(f"{t['id']}"), source="topics")
        cat = {"MedTech": "d:medtech", "Pharma": "d:pharma"}.get(t.get("category"))
        edge(cat or "root", "has_course", kid)
        for s in t["sections"]:
            for l in s.get("lessons", []):
                lid = "l:" + l["id"]
                node(lid, "lesson", l["title"], l["summary"], why=l.get("why", ""), link=lms(f"{t['id']}/{s['id']}"), source=t["id"])
                nodes[lid]["text"] = lesson_text(l)
                nodes[lid]["sections"] = l.get("sections", []) + ([{"h": "Worked example", **l["example"]}] if l.get("example") else [])
                edge(kid, "has_lesson", lid)
            if not s.get("lessons"):
                oid = f"o:{t['id']}:{s['id']}"
                node(oid, "outline", f'{t["title"]}: {s["title"]}', s.get("summary", ""), body="Covers: " + "; ".join(s.get("outline", [])) + ". This section is coming soon in the LMS.",
                     link=lms(f"{t['id']}/{s['id']}"), source=t["id"])
                edge(kid, "has_section", oid)

    # Learning path steps and every resource they and the playlist point to, so the chat can say what to do in a step and where to learn a topic.
    data = load(FDE / "public" / "tutor-data.json", {"steps": []})
    def resource(l, where):
        rid = "r:" + slug(l["url"])[-110:]
        if rid not in nodes:
            kind = {"video": "Video", "docs": "Reading", "course": "Course", "book": "Book"}.get(l["type"], l["type"].title())
            length = "optional, go further" if l.get("optional") else (f'{l["mins"]} min' if l.get("mins") else "self-paced")
            node(rid, "resource", l["title"], f'{kind} from {l["source"]} ({length}, {l.get("cost", "free")}). Recommended in {where}.', link=l["url"],
                 aliases=[l["title"].lower()], source="resources")
        return rid
    for st in data["steps"]:
        sid = "p:" + st["slug"]
        node(sid, "step", f'Learning path step {st["num"]}: {st["title"]}', st["what"], body=f'What to do: {st["task"]} Done when: {st["done"]}',
             link=f'{SITE}tldr.html#step-{st["slug"]}', aliases=[st["title"].lower(), f'step {st["num"].lower()}'], source="learning-path")
        edge("root", "covers", sid)
        for l in st.get("links", []):
            edge(sid, "uses", resource(l, f'learning path step {st["num"]}, {st["title"]}'))
    for g in load(C / "languages-playlist.json", {"groups": []})["groups"]:
        for it in g["items"]:
            for lv in it["levels"]:
                for l in lv["links"]:
                    edge("t:" + it["id"], "uses", resource(l, f'the {it["name"]} playlist, {lv["level"]} level'))

    # Concept links: a concept is related to another when its definition names it, and is taught in lessons that use it most.
    concepts = [n for n in nodes.values() if n["kind"] in ("concept", "tool")]
    pats = {n["id"]: pattern(n) for n in concepts}
    for n in concepts:
        text = f'{n["summary"]} {n["why"]}'
        for o in concepts:
            if o["id"] != n["id"] and pats[o["id"]].search(text):
                edge(n["id"], "related", o["id"])
    lessons = [n for n in nodes.values() if n["kind"] == "lesson"]
    for c in concepts:
        hits = sorted(((len(pats[c["id"]].findall(l["text"])), l["id"]) for l in lessons), reverse=True)
        for count, lid in hits[:3]:
            if count >= 2:
                edge(c["id"], "taught_in", lid)

    # Q&A: the site's prepared answers plus the foundations set, each tied to the concepts it is about.
    def attach(qid, text, names=()):
        for name in names:
            cid = "c:" + slug(name)
            tid = next((t for t in nodes if t.startswith("t:") and nodes[t]["title"].lower() == name.lower()), None)
            edge(qid, "about", cid if cid in nodes else tid)
        for c in concepts:
            if pats[c["id"]].search(text):
                edge(qid, "about", c["id"])

    for f in load(C / "faq.json", {"answers": []})["answers"]:
        qid = "q:" + f["id"]
        node(qid, "qa", f["q"], f["a"], link=(SITE + f["link"]) if f.get("link") else None, aliases=[k.lower() for k in f.get("keywords", [])], source="faq")
        qa.append({"id": qid, "q": f["q"], "alts": [], "a": f["a"]})
        attach(qid, f["q"])
    files = sorted((ROOT / "content").glob("*.json")) + sorted(f for d in EXTRA_CONTENT for f in d.glob("*.json"))
    entries = [(f.stem, e) for f in files for e in load(f, {"entries": []}).get("entries", [])]
    for src, e in entries:
        qid = "q:" + e["id"]
        if qid in nodes:
            continue
        node(qid, "qa", e["q"], e["a"], link=(e["link"] if e["link"].startswith("http") else SITE + e["link"]) if e.get("link") else None, aliases=[a.lower() for a in e.get("alts", [])], source=src)
        qa.append({"id": qid, "q": e["q"], "alts": e.get("alts", []), "a": e["a"]})
        attach(qid, e["q"] + " " + " ".join(e.get("alts", [])), e.get("concepts", []))

    for lid in [n for n in nodes if n.startswith("l:")]:
        l = nodes[lid]
        for i, sec in enumerate(l.pop("sections", []), 1):
            text = " ".join(sec.get("p", []) + sec.get("list", []))
            if not sec.get("h") or len(text) < 80:
                continue
            sid = f"s:{lid[2:]}:{i}"
            node(sid, "section", f'{l["title"]}: {sec["h"]}', clip(text, 900), link=l["link"], aliases=[sec["h"].lower()], source=l["source"])
            edge(lid, "has_section", sid)
    for n in nodes.values():
        n.pop("text", None)
        n.pop("sections", None)


def sql_str(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def write():
    OUT.mkdir(exist_ok=True)
    graph = {"nodes": list(nodes.values()), "edges": [list(e) for e in sorted(edges)], "qa": qa}
    (OUT / "graph.json").write_text(json.dumps(graph, ensure_ascii=True, indent=1), encoding="ascii")
    lines = ["DELETE FROM edges;", "DELETE FROM nodes;", "DELETE FROM search;"]
    for n in nodes.values():
        lines.append("INSERT INTO nodes (id, kind, title, summary, body, why, link, aliases, source) VALUES ("
                     + ", ".join(sql_str(n[k]) for k in ("id", "kind", "title", "summary", "body", "why", "link")) + f", {sql_str(json.dumps(n['aliases']))}, {sql_str(n['source'])});")
        lines.append(f"INSERT INTO search (id, title, text) VALUES ({sql_str(n['id'])}, {sql_str(n['title'] + ' ' + ' '.join(n['aliases']))}, {sql_str(n['summary'] + ' ' + n['why'])});")
    for a, rel, b in sorted(edges):
        lines.append(f"INSERT INTO edges (src, rel, dst) VALUES ({sql_str(a)}, {sql_str(rel)}, {sql_str(b)});")
    (OUT / "seed.sql").write_text("\n".join(lines) + "\n", encoding="ascii")
    kinds = {}
    for n in nodes.values():
        kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
    print("nodes", len(nodes), kinds, "edges", len(edges), "qa", len(qa))


if __name__ == "__main__":
    build()
    write()
