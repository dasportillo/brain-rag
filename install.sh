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
cp "$REPO_DIR"/{transcripts,store,embed,ingest,search,server,mark-current-keep,mark-keep}.mjs "$BRAIN_DIR"/
cp "$REPO_DIR"/package.json "$BRAIN_DIR"/
[ -f "$REPO_DIR/package-lock.json" ] && cp "$REPO_DIR/package-lock.json" "$BRAIN_DIR"/

# 2. Deploy the slash commands (/brain = opt a session in, /state = write the curated state note).
mkdir -p "$HOME/.claude/commands"
cp "$REPO_DIR"/commands/*.md "$HOME/.claude/commands/"

# 3. Dependencies (embedding model + MCP SDK).
echo "▸ npm install"
( cd "$BRAIN_DIR" && npm install --no-audit --no-fund )

# 4. Register the MCP server globally (skip if already present).
if claude mcp list 2>/dev/null | grep -q '^brain\b'; then
  echo "▸ MCP server 'brain' already registered — skipping"
else
  echo "▸ registering MCP server 'brain' (scope user)"
  claude mcp add brain --scope user -- node "$BRAIN_DIR/server.mjs"
fi

# 5. Opt-in wiring (manual step — we print it rather than edit settings.json for you).
#    The brain is OFF by default: a session is indexed ONLY if you opt it in.
cat <<EOF

▸ OPT-IN wiring — the brain saves NOTHING unless you opt a session in.

  a) Add these two entries to ~/.claude/settings.json (keep any existing entries):

     "SessionStart": [{
       "matcher": "",
       "hooks": [{ "type": "command",
         "command": "node \"$BRAIN_DIR/mark-keep.mjs\"", "timeout": 5 }]
     }]

     "SessionEnd": [{
       "matcher": "",
       "hooks": [{ "type": "command",
         "command": "nohup node \"$BRAIN_DIR/ingest.mjs\" >> \"$BRAIN_DIR/ingest.log\" 2>&1 &",
         "timeout": 20 }]
     }]

     SessionStart + BRAIN=1 marks the whole session to be saved; SessionEnd indexes
     only the marked (opted-in) sessions, incrementally.

  b) Optional shell wrapper — start an opted-in session with 'claude --brain':

     claude() {
       local brain=0 args=()
       for a in "\$@"; do case "\$a" in --brain) brain=1 ;; *) args+=("\$a") ;; esac; done
       if (( brain )); then BRAIN=1 command claude "\${args[@]}"; else command claude "\${args[@]}"; fi
     }

  c) Mid-session, run /brain to opt the CURRENT conversation in.
  d) Run /state [project] to synthesize and save a project's current-state note (served by get_state).
EOF

echo "✔ done. Opt a session in (claude --brain or /brain), then: node \"$BRAIN_DIR/search.mjs\" \"what am I working on\""
