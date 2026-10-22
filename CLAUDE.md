# AI knowledge service (Ask chat)

Knowledge graph of the FDE program content plus written Q&A, served read-only from D1 by a Pages Function. Needle 2 (needle-rs WASM, Cactus Compute weights, MIT) runs in the learner's browser to turn a question into a 128-number vector; the server ranks entries with that vector plus keyword search and exact names. Workers AI writes a short answer from the closest entries only when no single entry clearly answers.

- Run: `./setup.sh setup` the first time, then `start`, `stop`, `status`, `build`, `load`, `eval`. Local port 8792. Settings come from `.env` (see `.env.example`); the AI fallback uses the Workers AI of the account in `.env`, even locally.
- Content: `content/*.json` (Q&A entries: foundations, tech, industry, fde-work, glossary) plus everything in ~/projects/ai/fde-training/content. `build/build_graph.py` makes `out/graph.json` and `out/seed.sql`; `build/embed.mjs` makes `public/vectors.json`. Rebuild both after any content change, then `load` and restart. Private extra content is read from the folders in `KB_EXTRA_TOPICS` and `KB_EXTRA_CONTENT`; keep it out of this repo.
- Quality: `eval/questions.json` is a held-out test set (do not tune content to it directly). `./setup.sh eval` prints good-answer rates per area and writes `eval/report.json`.
- Widget: any allowed site adds `<script src="https://quick-chat-program.pages.dev/kb.js" defer></script>`. Allowed origins are listed at the top of `src/api.js`.
- Security: the API is GET-only, fixed SELECTs with bound values, size limits, origin allowlist. Do not add write routes.
- Deploy: `CONFIRM=yes ./setup.sh publish` (rebuild, then remote D1 and the Pages project named in `.env`). Never commit `.env` or `wrangler.toml`; `wrangler.toml` is rendered from `wrangler.toml.template`.
- ASCII only in code and content.
