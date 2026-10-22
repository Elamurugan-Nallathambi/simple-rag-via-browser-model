#!/usr/bin/env bash
# AI knowledge service: knowledge graph built from fde-training content, served read-only from D1 by a Pages Function; Needle 2 runs in the browser.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="ai-knowledge"
# Settings live in .env (never committed); see .env.example.
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }
PAGES_PROJECT="${PAGES_PROJECT:-quick-chat-program}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-ai-knowledge}"
D1_DATABASE_ID="${D1_DATABASE_ID:-00000000-0000-0000-0000-000000000000}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://fde-training-program.pages.dev,https://quick-chat-program.pages.dev}"
export PAGES_PROJECT D1_DATABASE_NAME D1_DATABASE_ID ALLOWED_ORIGINS
PORT="${PORT:-8792}"
PID_FILE="/tmp/${NAME}-dev.pid"
LOG_FILE="/tmp/${NAME}-dev.log"
FDE="${FDE_DIR:-../fde-training}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"

log()  { printf '\033[34m[%s]\033[0m %s\n' "$NAME" "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; }

prereqs() { for t in node npx python3 curl lsof; do command -v "$t" >/dev/null || { err "missing prerequisite: $t"; exit 1; }; done; ok "prerequisites present"; }
is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
kill_port() { local p; p="$(lsof -ti tcp:"$PORT" || true)"; [[ -n "$p" ]] && { warn "freeing port $PORT"; kill $p 2>/dev/null || true; sleep 1; }; return 0; }

# Needle 2 weights (MIT, Cactus Compute) are not kept in git; fetched once from Hugging Face and checked against a known hash.
CACT_SHA="b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba"
model() {
  local f="$ROOT/public/needle/needle2.cact"
  if [[ ! -f "$f" ]]; then log "downloading Needle 2 weights"; curl -sL -o "$f" https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact; fi
  [[ "$(shasum -a 256 "$f" | cut -d' ' -f1)" == "$CACT_SHA" ]] || { err "needle2.cact checksum mismatch"; rm -f "$f"; exit 1; }
  ok "Needle 2 weights present"
}

build() {
  model
  log "building the graph from $FDE"
  python3 "$ROOT/build/build_graph.py" "$FDE"
  log "embedding phrases with Needle 2 (a few minutes)"
  node "$ROOT/build/embed.mjs"
}

# wrangler.toml is generated from the template so no account-specific id is committed.
config() { python3 -c 'import os,sys; open(sys.argv[2],"w").write(os.path.expandvars(open(sys.argv[1]).read()))' "$ROOT/wrangler.toml.template" "$ROOT/wrangler.toml"; }

load_local() {
  config
  (cd "$ROOT" && npx wrangler d1 migrations apply "$D1_DATABASE_NAME" --local >/dev/null && npx wrangler d1 execute "$D1_DATABASE_NAME" --local --file out/seed.sql >/dev/null) && ok "local D1 loaded"
}

start() {
  config
  if is_running; then ok "already running (pid $(cat "$PID_FILE"))"; return; fi
  kill_port
  (cd "$ROOT" && CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" nohup npx wrangler pages dev public --port "$PORT" --ip 127.0.0.1 >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE")
  for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { ok "up at http://127.0.0.1:$PORT"; return 0; }; sleep 1; done
  err "did not start; see $LOG_FILE"; tail -20 "$LOG_FILE"; exit 1
}

stop() { if is_running; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; fi; kill_port; ok "stopped"; }

status() {
  if is_running; then ok "running at http://127.0.0.1:$PORT"; else warn "not running"; fi
  [[ -f "$ROOT/out/graph.json" ]] && log "graph: $(python3 -c "import json;g=json.load(open('$ROOT/out/graph.json'));print(len(g['nodes']),'nodes,',len(g['edges']),'edges')")"
}

deploy() {
  [[ "${CONFIRM:-}" == "yes" ]] || { err "deploy writes to Cloudflare; run with CONFIRM=yes after approval"; exit 1; }
  [[ -n "$CF_ACCOUNT_ID" && "$D1_DATABASE_ID" != 00000000-* ]] || { err "set CF_ACCOUNT_ID and D1_DATABASE_ID in .env (see .env.example)"; exit 1; }
  config
  (cd "$ROOT" && CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" npx wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote)
  (cd "$ROOT" && CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --file out/seed.sql)
  (cd "$ROOT" && CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" npx wrangler pages deploy public --project-name "$PAGES_PROJECT" --branch main --commit-dirty=true)
}

help() {
  cat <<H
Usage: ./setup.sh <command>
  setup     first time: check tools, build graph and vectors, load local D1, start
  start     start locally (wrangler pages dev, local D1) on port $PORT
  stop      stop it
  restart   stop then start
  status    running or not, graph size
  logs      follow the dev log ($LOG_FILE)
  build     rebuild graph (out/) and Needle 2 vectors (public/vectors.json) from $FDE
  load      load out/seed.sql into the local D1
  eval      score the chat on eval/questions.json against the running local API
  publish   CONFIRM=yes: rebuild from the latest course content (build), then deploy; run after any content change
  deploy    CONFIRM=yes: apply schema and data to the remote D1, deploy the Pages project ($PAGES_PROJECT)
  help      this list
H
}

case "${1:-help}" in
  setup) prereqs; build; load_local; start ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -f "$LOG_FILE" ;;
  build) build ;;
  load) load_local ;;
  eval) node "$ROOT/eval/run.mjs" "http://127.0.0.1:$PORT" ;;
  publish) [[ "${CONFIRM:-}" == "yes" ]] || { err "publish writes to Cloudflare; run with CONFIRM=yes after approval"; exit 1; }; build; deploy ;;
  deploy) deploy ;;
  help|*) help ;;
esac
