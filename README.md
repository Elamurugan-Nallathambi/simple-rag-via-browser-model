# AI knowledge chat service

The Ask chat behind the [FDE Training Program](https://fde-training-program.pages.dev). It answers questions about AI, programming, cloud and security, the FDE role, the program itself, and MedTech and Pharma quality topics, using only the program's content.

**Live service:** https://quick-chat-program.pages.dev (open it to ask questions and browse the knowledge map)

## How it works

1. **In the browser.** The widget loads Needle 2, a small open model (about 14 MB, cached once), into a Web Worker. It turns the question into 128 numbers that capture its meaning. Nothing is sent to an AI service at this point.
2. **One request.** The browser sends the question and those numbers to `/api/ask`. That is a read-only Cloudflare Pages Function, and it is the only part that can read the database.
3. **Finding the answer.** The function combines three signals: an exact name lookup and keyword search in D1, and comparison with about 8,000 prepared phrase vectors. If one entry clearly wins, it returns that entry from the knowledge graph with related topics, the lesson to read and learning resources.
4. **When nothing clearly wins,** a small model on Workers AI writes a short answer only from the five closest entries and cites them, or says it does not know.

The knowledge graph is built from the program's content: concepts, lessons and lesson sections, learning path steps, resources, and about 1,300 written questions and answers. A held-out test set of 301 questions measures the quality.

## Use it on a site

Add one line to any page on an allowed site:

```html
<script src="https://quick-chat-program.pages.dev/kb.js" defer></script>
```

An "Ask" button appears at the bottom right. The panel uses the host page's colours when the page defines them, so it follows light and dark mode. Allowed sites are set in `ALLOWED_ORIGINS`.

## Run it locally

You need Python 3.10 or newer, Node.js 18 or newer, and a copy of the [FDE Training Program](https://github.com/Elamurugan-Nallathambi/fde-training) next to this folder.

```bash
git clone https://github.com/Elamurugan-Nallathambi/fde-training.git
```

```bash
git clone https://github.com/Elamurugan-Nallathambi/ai-knowledge.git
```

```bash
cd ai-knowledge && cp .env.example .env && ./setup.sh setup
```

`setup` downloads the Needle 2 weights (checked against a known hash), builds the graph and the vectors, loads a local D1 database and starts the service at http://127.0.0.1:8792. The fallback answers need Workers AI, which uses your Cloudflare account even locally (`npx wrangler login`).

| Command | What it does |
|---|---|
| `./setup.sh build` | Rebuild the graph (`out/`) and the vectors (`public/vectors.json`) from the latest content |
| `./setup.sh load` | Load the graph into the local D1 database |
| `./setup.sh start`, `stop`, `restart`, `status`, `logs` | Run the local service |
| `./setup.sh eval` | Score the chat on the test set; writes `eval/report.json` |
| `CONFIRM=yes ./setup.sh publish` | Rebuild, then deploy the data and the site |

## Layout

| Path | What it is |
|---|---|
| `content/*.json` | Written questions and answers (foundations, tech, industry, FDE work, glossary, learning path) |
| `build/build_graph.py` | Builds the knowledge graph from this content and the FDE program content |
| `build/embed.mjs` | Embeds every phrase with Needle 2, one engine per CPU core |
| `src/api.js`, `functions/` | The read-only API: `/api/ask`, `/api/node/:id`, `/api/search`, `/api/overview` |
| `public/kb.js`, `public/kb.css` | The Ask widget |
| `public/index.html` | The knowledge map page |
| `eval/` | The held-out test set and the scorer |

## Settings

Everything account-specific lives in `.env`, which is never committed (see `.env.example`). `./setup.sh` renders `wrangler.toml` from `wrangler.toml.template` with those values.

| Setting | Purpose |
|---|---|
| `CF_ACCOUNT_ID`, `PAGES_PROJECT`, `D1_DATABASE_NAME`, `D1_DATABASE_ID` | Your Cloudflare account, Pages project and D1 database (`npx wrangler d1 create <name>`) |
| `ALLOWED_ORIGINS` | Sites allowed to call the API |
| `FDE_DIR`, `KB_SITE_URL` | Where the program content is, and the site answers link to |
| `KB_LMS_URL`, `KB_EXTRA_TOPICS`, `KB_EXTRA_CONTENT`, `KB_EXTRA_EVAL` | Optional: an LMS that hosts topic courses, plus extra private course, answer and test folders |

## Security

The API only answers GET requests. It runs fixed SELECT statements with bound values, limits the size of every input, and only answers the allowed sites. The browser never touches the database. Do not add write routes.

## Credits

Needle 2 is by [Cactus Compute](https://github.com/cactus-compute/needle) (MIT licence), run in the browser with [needle-rs](https://github.com/geekgineer/needle-rs) (MIT licence). Their licence and notice files are in `public/needle/`.
