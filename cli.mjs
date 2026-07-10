#!/usr/bin/env node
// Single entry point for the published package: `brain-rag <command>` routes to the right module.
// Each delegated module reads its own flags from process.argv, so we strip the subcommand first.
const [cmd, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], process.argv[1], ...rest];

switch (cmd) {
  case 'serve':        await import('./server.mjs'); break;              // MCP stdio server (claude mcp add)
  case 'ingest':       await import('./ingest.mjs'); break;             // index opted-in transcripts
  case 'import':       await import('./import.mjs'); break;             // backfill existing transcripts
  case 'stats':        process.argv.push('--stats'); await import('./ingest.mjs'); break;
  case 'search':       await import('./search.mjs'); break;             // CLI search
  case 'state':        await import('./state.mjs'); break;              // dump a project's recent activity
  case 'mark-keep':    await import('./mark-keep.mjs'); break;          // SessionStart opt-in hook
  case 'mark-current': await import('./mark-current-keep.mjs'); break;  // /brain backend
  case 'install':      await import('./install.mjs'); break;            // wire into Claude Code
  case 'uninstall':    await import('./uninstall.mjs'); break;          // unregister + remove commands
  default:
    console.log(`brain-rag — local, private RAG second brain over your Claude Code transcripts

Usage: brain-rag <command>

  install         Register the MCP server + slash commands, and print the hook wiring
  uninstall       Reverse of install (add --purge to also delete the index + state)
  serve           Run the MCP server (stdio) — this is what 'claude mcp add' launches
  ingest          Ingest opted-in transcripts into the index
  import [filter] Backfill EXISTING conversations into the brain (--dry to preview)
  stats           Print index status
  search "query"  Search the brain from the CLI
  state [project] Dump a project's recent activity (raw material for /state)
  mark-keep       SessionStart hook: opt a BRAIN=1 session in
  mark-current    Opt the CURRENT session in (the /brain command backend)
`);
    if (cmd && !['help', '--help', '-h'].includes(cmd)) process.exit(1);
}
