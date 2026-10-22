-- Knowledge graph: nodes (concepts, tools, lessons, domains, Q&A...), typed edges between them, and a full-text index.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  why TEXT,
  link TEXT,
  aliases TEXT,
  source TEXT
);
CREATE TABLE edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, rel, dst));
CREATE INDEX edges_dst ON edges(dst);
CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, title, text, tokenize = 'porter');
