// Single source of truth for the memory-extraction prompt (v0.8 "automatic extraction").
// THREE runners share it, so it stays agent-agnostic (no host-specific tooling assumed):
//   - Claude Code /distill slash command  (install.mjs writes it to ~/.claude/commands/distill.md)
//   - Codex /distill custom prompt        (install.mjs writes it to ~/.codex/prompts/distill.md)
//   - headless batch extraction           (distill.mjs wraps it via headlessDistillPrompt)
import { MEMORY_TYPES } from './store.mjs';

// In-session extraction: the AGENT distills, the server just stores (save_memories).
// Step 1 is the TODO lifecycle: open 'todo' memories are the brain's task list — a session that
// resolves one must RETIRE it via supersedes, or completed work keeps resurfacing as "open".
export const DISTILL_PROMPT = `Distill THIS conversation into durable memories and save them to the second brain.

1. TODO lifecycle first: fetch the project's OPEN 'todo' memories — call \`search_context\` from the \`brain\` MCP server with layer:"memories" (or use the "Open TODOs" list when one is provided with this prompt). If this conversation RESOLVED one, save its resolution with supersedes:<id> so the stale TODO retires. Leave still-open TODOs alone.
2. Review the conversation for knowledge worth keeping beyond this chat: decisions (with their WHY), bug root causes, solutions, architecture facts, preferences, workflows, lessons learned, open TODOs.
3. For each one, build a SELF-CONTAINED memory (readable without the conversation): a short stable title, the fact + why + minimal context, the right type, entities it touches, and 1-2 short verbatim quotes from the conversation as source_messages.
4. Call the \`save_memories\` tool from the \`brain\` MCP server with ALL of them in one batch (3-8 memories is typical; skip trivia and dead ends). If the response warns an existing memory is now outdated, save again with supersedes:<id>.
5. Report one line per saved memory.
`;

// Headless variant (batch/hook extraction over a session DIGEST, not a live conversation):
// `claude -p` runs with NO MCP tools, so instead of calling save_memories the model must PRINT
// the memories — distill.mjs parses the array (parseMemoriesJson) and saves them itself. The
// open-TODO list travels inside the input (no search_context available headless), and the type
// vocabulary is spelled out because there is no tool schema to constrain it.
export function headlessDistillPrompt(input) {
  return `You are a memory extractor for a developer's private "second brain". Below is a compact DIGEST of one already-finished coding session (title, compaction summary, first and last user messages, the tool-action trace) and, when present, the project's OPEN TODO memories.

Extract the knowledge worth keeping beyond that session: decisions (with their WHY), bug root causes, solutions, architecture facts, preferences, workflows, lessons learned, open TODOs. Each memory must be SELF-CONTAINED (readable without the session): a short stable title, the fact + why + minimal context, the right type, the entities it touches, and 1-2 short verbatim quotes from the digest as source_messages. Skip trivia and dead ends (3-8 memories is typical). TODO lifecycle: if the session RESOLVED one of the listed open TODOs, emit its resolution with "supersedes" set to that TODO's id so it retires; leave still-open TODOs alone.

OUTPUT ONLY a JSON array — no prose, no markdown fences. Each element:
  {"type": "<${MEMORY_TYPES.join('|')}>", "title": "...", "content": "...", "confidence": 0.0-1.0 (optional), "entities": ["..."] (optional), "source_messages": ["short verbatim quote"] (optional), "supersedes": <id of the open TODO this resolves> (optional)}
Output [] when nothing is durable.

--- SESSION DIGEST ---
${input}`;
}
