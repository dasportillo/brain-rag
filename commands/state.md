---
description: Synthesize and save the curated current-state note for a project (state/<project>.md)
allowed-tools: Bash(node:*), mcp__brain__save_state
---
Build and persist the curated CURRENT-STATE note for the project `$ARGUMENTS` (if empty, infer it from the current working directory — the dashified cwd, the same name the brain uses).

1. Run `node ~/.claude/brain/state.mjs $ARGUMENTS` to gather the project's recent activity from the brain. (With no argument, run `node ~/.claude/brain/state.mjs --list` first and pick the project matching the current cwd.)
2. From that material, synthesize a concise note with these sections: **Now**, **In flight**, **Decisions**, **Blockers**, **Next**. Keep it tight and current — omit anything that was reverted or superseded.
3. Call the `save_state` tool with that Markdown (pass the same project name if one was given).
4. Report the saved path on a single line.
