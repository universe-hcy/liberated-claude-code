#!/usr/bin/env bash
# Deploy FTS5 cross-session search to ~/.claude/
# Run from repo root: bash dotclaude/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "=== Deploying FTS5 cross-session search ==="

# 1. Deploy session_search.py
mkdir -p "$CLAUDE_DIR/scripts"
cp "$SCRIPT_DIR/scripts/session_search.py" "$CLAUDE_DIR/scripts/session_search.py"
echo "[OK] Deployed session_search.py -> $CLAUDE_DIR/scripts/"

# 2. Deploy SKILL.md
mkdir -p "$CLAUDE_DIR/skills/session-search"
cp "$SCRIPT_DIR/skills/session-search/SKILL.md" "$CLAUDE_DIR/skills/session-search/SKILL.md"
echo "[OK] Deployed SKILL.md -> $CLAUDE_DIR/skills/session-search/"

# 3. Configure Stop hook in settings.json
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK_CMD="python3 $CLAUDE_DIR/scripts/session_search.py index > /dev/null 2>&1 &"

if [ ! -f "$SETTINGS" ]; then
    # Create minimal settings.json with Stop hook
    cat > "$SETTINGS" << EOJSON
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_CMD"
          }
        ]
      }
    ]
  }
}
EOJSON
    echo "[OK] Created $SETTINGS with Stop hook"
else
    # Check if Stop hook already exists
    if python3 -c "
import json, sys
with open('$SETTINGS') as f:
    s = json.load(f)
hooks = s.get('hooks', {}).get('Stop', [])
for h in hooks:
    for sub in h.get('hooks', []):
        if 'session_search' in sub.get('command', ''):
            sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
        echo "[OK] Stop hook already configured in $SETTINGS"
    else
        # Add Stop hook using Python to preserve existing JSON structure
        python3 -c "
import json
with open('$SETTINGS') as f:
    s = json.load(f)
s.setdefault('hooks', {}).setdefault('Stop', []).append({
    'matcher': '',
    'hooks': [{
        'type': 'command',
        'command': '$HOOK_CMD'
    }]
})
with open('$SETTINGS', 'w') as f:
    json.dump(s, f, indent=2)
"
        echo "[OK] Added Stop hook to $SETTINGS"
    fi
fi

# 4. Build initial index
echo ""
echo "=== Building initial FTS5 index ==="
python3 "$CLAUDE_DIR/scripts/session_search.py" index 2>&1

echo ""
echo "=== Done ==="
echo "Usage: python3 ~/.claude/scripts/session_search.py search \"your query\""
echo "Index auto-updates after each Claude Code session via Stop hook."
