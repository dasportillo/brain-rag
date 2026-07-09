#!/usr/bin/env bash
# Install brain-rag as the runtime under ~/.claude/brain and wire it into Claude Code.
# Idempotent: safe to re-run after pulling changes. Never touches an existing brain.db.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAIN_DIR="${BRAIN_DIR:-$HOME/.claude/brain}"

echo "▸ brain-rag install"
echo "  repo:    $REPO_DIR"
echo "  runtime: $BRAIN_DIR"

# 1. Deploy the runtime source (code only — never the DB, logs or node_modules).
mkdir -p "$BRAIN_DIR"
cp "$REPO_DIR"/{transcripts,store,embed,ingest,search,server}.mjs "$BRAIN_DIR"/
cp "$REPO_DIR"/package.json "$BRAIN_DIR"/
[ -f "$REPO_DIR/package-lock.json" ] && cp "$REPO_DIR/package-lock.json" "$BRAIN_DIR"/

# 2. Dependencies (embedding model + MCP SDK).
echo "▸ npm install"
( cd "$BRAIN_DIR" && npm install --no-audit --no-fund )

# 3. Register the MCP server globally (skip if already present).
if claude mcp list 2>/dev/null | grep -q '^brain\b'; then
  echo "▸ MCP server 'brain' already registered — skipping"
else
  echo "▸ registering MCP server 'brain' (scope user)"
  claude mcp add brain --scope user -- node "$BRAIN_DIR/server.mjs"
fi

# 4. Auto-update hook (manual step — we print it rather than edit settings.json for you).
cat <<EOF

▸ OPTIONAL — auto-update on session close
  Add this second entry to "SessionEnd" in ~/.claude/settings.json (keep any existing entries):

  {
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "nohup node \"$BRAIN_DIR/ingest.mjs\" >> \"$BRAIN_DIR/ingest.log\" 2>&1 &",
      "timeout": 20
    }]
  }
EOF

# 5. Initial backfill.
echo "▸ running initial backfill (first run downloads the embedding model)…"
( cd "$BRAIN_DIR" && node ingest.mjs )

echo "✔ done. Try: node \"$BRAIN_DIR/search.mjs\" \"what am I working on\""
