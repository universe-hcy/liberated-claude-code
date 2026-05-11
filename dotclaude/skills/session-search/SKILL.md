---
name: session-search
description: Search past Claude Code sessions using FTS5 full-text search index
allowed-tools:
  - Bash(python3 ~/.claude/scripts/session_search.py *)
when_to_use: Use when the user asks about past conversations, previous sessions, or wants to find something discussed before. Examples: 'what did we talk about last time', 'find the session where we discussed X', 'search past conversations for Y', 'how did we solve X before'
argument-hint: "<search query>"
arguments:
  - query
---

# Session Search

Search past Claude Code sessions using a local FTS5 full-text search index.

## How to use

Run the search script via Bash:

```bash
python3 ~/.claude/scripts/session_search.py search "$query"
```

Options:
- `--limit N`: Return at most N results (default 5)

The script returns JSON with matching snippets, session IDs, project paths, and session summaries.

## Notes

- The index is automatically updated after each session via a Stop hook
- Supports both English (unicode61 tokenizer) and CJK characters (trigram tokenizer)
- The script auto-selects the appropriate tokenizer based on query content
- To manually rebuild the index: `python3 ~/.claude/scripts/session_search.py index`
