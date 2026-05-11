#!/usr/bin/env python3
"""
FTS5 cross-session search for Claude Code.

Usage:
    python3 session_search.py index          # Build/update the index
    python3 session_search.py search "query" # Search sessions
    python3 session_search.py search "query" --limit 10
"""

import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime
from pathlib import Path


def get_db_path():
    return os.path.join(os.path.expanduser("~"), ".claude", "session_search.db")


def get_projects_dir():
    return os.path.join(os.path.expanduser("~"), ".claude", "projects")


def has_cjk(text):
    for ch in text:
        cp = ord(ch)
        if (
            (0x4E00 <= cp <= 0x9FFF)
            or (0x3400 <= cp <= 0x4DBF)
            or (0x20000 <= cp <= 0x2A6DF)
            or (0x2A700 <= cp <= 0x2B73F)
            or (0x2B740 <= cp <= 0x2B81F)
            or (0x3040 <= cp <= 0x309F)
            or (0x30A0 <= cp <= 0x30FF)
            or (0xAC00 <= cp <= 0xD7AF)
        ):
            return True
    return False


def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "tool_result":
                    for sub in block.get("content", []):
                        if isinstance(sub, dict) and sub.get("type") == "text":
                            parts.append(sub.get("text", ""))
        return " ".join(p for p in parts if p)
    return ""


def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            project_path TEXT,
            last_indexed TEXT,
            message_count INTEGER,
            summary TEXT
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            session_id,
            role,
            content,
            tokenize='unicode61'
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
            session_id,
            role,
            content,
            tokenize='trigram'
        )
    """)
    conn.commit()


def index_session(conn, session_id, jsonl_path, project_path):
    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime).isoformat()
    row = conn.execute(
        "SELECT last_indexed FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row and row[0] >= mtime:
        return 0

    conn.execute(
        "DELETE FROM messages_fts WHERE session_id=?", (session_id,)
    )
    conn.execute(
        "DELETE FROM messages_fts_trigram WHERE session_id=?", (session_id,)
    )

    count = 0
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                entry_type = entry.get("type", "")
                if entry_type not in ("user", "assistant"):
                    continue

                msg = entry.get("message", {})
                if not isinstance(msg, dict):
                    continue

                role = msg.get("role", entry_type)
                text = extract_text(msg.get("content", ""))
                if not text or len(text) < 10:
                    continue

                conn.execute(
                    "INSERT INTO messages_fts(session_id, role, content) VALUES (?, ?, ?)",
                    (session_id, role, text),
                )
                conn.execute(
                    "INSERT INTO messages_fts_trigram(session_id, role, content) VALUES (?, ?, ?)",
                    (session_id, role, text),
                )
                count += 1
    except Exception as e:
        print(f"Warning: error reading {jsonl_path}: {e}", file=sys.stderr)
        return 0

    summary = ""
    summary_path = jsonl_path.parent / "session-memory" / "summary.md"
    if summary_path.exists():
        try:
            summary = summary_path.read_text(encoding="utf-8")[:2000]
        except Exception:
            pass

    conn.execute(
        """INSERT OR REPLACE INTO sessions
           (session_id, project_path, last_indexed, message_count, summary)
           VALUES (?, ?, ?, ?, ?)""",
        (session_id, str(project_path), mtime, count, summary),
    )
    return count


def do_index():
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    init_db(conn)

    projects_dir = Path(get_projects_dir())
    if not projects_dir.exists():
        print("No projects directory found.", file=sys.stderr)
        conn.close()
        return

    total_new = 0
    total_sessions = 0

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for item in project_dir.iterdir():
            if item.is_file() and item.suffix == ".jsonl":
                session_id = item.stem
                new_count = index_session(conn, session_id, item, project_dir)
                total_new += new_count
                total_sessions += 1

    conn.commit()
    conn.close()
    print(
        f"Indexed {total_sessions} sessions, {total_new} new messages.",
        file=sys.stderr,
    )


def do_search(query, limit=5):
    db_path = get_db_path()
    if not os.path.exists(db_path):
        print(json.dumps({"error": "Index not built. Run: python3 session_search.py index"}))
        return

    conn = sqlite3.connect(db_path)

    use_trigram = has_cjk(query)

    table = "messages_fts_trigram" if use_trigram else "messages_fts"

    try:
        if use_trigram:
            escaped = query.replace('"', '""')
            fts_query = f'"{escaped}"'
        else:
            terms = query.strip().split()
            fts_query = " AND ".join(f'"{t}"' for t in terms if t)

        rows = conn.execute(
            f"""
            SELECT
                {table}.session_id,
                {table}.role,
                snippet({table}, 2, '>>>', '<<<', '...', 64) as snippet,
                s.project_path,
                s.summary
            FROM {table}
            JOIN sessions s ON s.session_id = {table}.session_id
            WHERE {table} MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, limit),
        ).fetchall()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        conn.close()
        return

    results = []
    for row in rows:
        results.append(
            {
                "session_id": row[0],
                "role": row[1],
                "snippet": row[2],
                "project_path": row[3],
                "summary": (row[4] or "")[:500],
            }
        )

    conn.close()
    print(json.dumps({"query": query, "table": table, "results": results}, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "index":
        do_index()
    elif cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: session_search.py search <query> [--limit N]")
            sys.exit(1)
        query = sys.argv[2]
        limit = 5
        if "--limit" in sys.argv:
            idx = sys.argv.index("--limit")
            if idx + 1 < len(sys.argv):
                limit = int(sys.argv[idx + 1])
        do_search(query, limit)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
